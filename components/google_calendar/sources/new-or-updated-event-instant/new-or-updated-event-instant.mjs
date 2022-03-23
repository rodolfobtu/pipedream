import { v4 as uuid } from "uuid";
import googleCalendar from "../../google_calendar.app.js";

export default {
  key: "google_calendar-new-or-updated-event-instant",
  type: "source",
  name: "New or Updated Event (Instant)",
  description: "Emit new calendar events when an event is created or updated (does not emit cancelled events)",
  version: "0.1.1",
  dedupe: "unique",
  props: {
    googleCalendar,
    db: "$.service.db",
    calendarIds: {
      type: "string[]",
      label: "Calendars",
      description: "Select one or more calendars to watch",
      async options() {
        const calListResp = await this.googleCalendar.calendarList();
        const calendars = calListResp?.data?.items ?? [];
        if (calendars && calendars.length) {
          const calendarIds = calendars.map((item) => ({
            value: item.id,
            label: item.summary,
          }));
          return calendarIds;
        }
        return [];
      },
    },
    newOnly: {
      label: "New events only?",
      type: "boolean",
      description: "Emit new events only, and not updates to existing events",
      optional: true,
      default: false,
    },
    http: "$.interface.http",
    timer: {
      label: "Push notification renewal schedule",
      description: "The Google Calendar API requires occasional renewal of push notification subscriptions. **This runs in the background, so you should not need to modify this schedule**.",
      type: "$.interface.timer",
      static: {
        intervalSeconds: 60 * 60 * 23,
      },
    },
  },
  hooks: {
    async activate() {
      await this.makeWatchRequest();
    },
    async deactivate() {
      await this.stopWatchRequest();
    },
  },
  methods: {
    /**
     * A utility method to compute whether the provided event is newly created
     * or not. Since the Google Calendar API does not provide a specific way to
     * determine this, this method estimates the result based on the `created`
     * and `updated` timestamps: if they are more than 2 seconds apart, then we
     * assume that the event is not new.
     *
     * @param {Object} event - The calendar event being processed
     * @returns {Boolean} True if the input event is a newly created event, or
     * false otherwise
     */
    _isNewEvent(event) {
      const {
        created,
        updated,
      } = event;
      const createdTimestampMilliseconds = Date.parse(created);
      const updatedTimestampMilliseconds = Date.parse(updated);
      const diffMilliseconds = Math.abs(
        updatedTimestampMilliseconds - createdTimestampMilliseconds,
      );
      const maxDiffMilliseconds = 2000;
      return diffMilliseconds <= maxDiffMilliseconds;
    },
    /**
     * A utility method to compute whether the provided event is relevant to the
     * event source (and as a consequence must be processed) or not.
     *
     * @param {Object} event - The calendar event being processed
     * @returns {Boolean} True if the input event must be processed, or false
     * otherwise (i.e. if the event must be skipped)
     */
    isEventRelevant(event) {
      return !this.newOnly || this._isNewEvent(event);
    },
    generateMeta(event) {
      const {
        id,
        summary,
        updated: tsString,
      } = event;
      const ts = Date.parse(tsString);
      return {
        id: `${id}-${ts}`,
        summary,
        ts,
      };
    },
    async makeWatchRequest() {
      // Make watch request for this HTTP endpoint
      for (const calendarId of this.calendarIds) {
        const config = {
          calendarId,
          requestBody: {
            id: uuid(),
            type: "web_hook",
            address: this.http.endpoint,
          },
        };
        const watchResp = await this.googleCalendar.watch(config);
        const data = watchResp.data;

        // Initial full sync. Get next sync token
        const nextSyncToken = await this.googleCalendar.fullSync(calendarId);

        this.db.set(`${calendarId}.nextSyncToken`, nextSyncToken);
        this.db.set(`${calendarId}.channelId`, data.id);
        this.db.set(`${calendarId}.resourceId`, data.resourceId);
        this.db.set(`${calendarId}.expiration`, data.expiration);
      }
    },
    async stopWatchRequest() {
      for (const calendarId of this.calendarIds) {
        const id = this.db.get(`${calendarId}.channelId`);
        const resourceId = this.db.get(`${calendarId}.resourceId`);
        if (id && resourceId) {
          const config = {
            requestBody: {
              id,
              resourceId,
            },
          };
          const stopResp = await this.googleCalendar.stop(config);
          if (stopResp.status === 204) {
            console.log("webhook deactivated");
            this.db.set(`${calendarId}.nextSyncToken`, null);
            this.db.set(`${calendarId}.channelId`, null);
            this.db.set(`${calendarId}.resourceId`, null);
            this.db.set(`${calendarId}.expiration`, null);
          } else {
            console.log("There was a problem deactivating the webhook");
          }
        }
      }
    },
  },
  async run(event) {
    // refresh watch
    if (event.interval_seconds) {
      // get time
      const now = new Date();
      const intervalMs = event.interval_seconds * 1000;
      // get expiration
      const expiration = this.db.get(`${this.calendarIds[0]}.expiration`);
      const expireDate = new Date(parseInt(expiration));

      // if now + interval > expiration, refresh watch
      if (now.getTime() + intervalMs > expireDate.getTime()) {
        await this.makeWatchRequest();
        await this.stopWatchRequest();
      }
    } else {
      // Verify channel ID
      const channelIds = [];
      for (const calendarId of this.calendarIds) {
        const channelId = this.db.get(`${calendarId}.channelId`);
        channelIds.push(channelId);
      }
      const incomingChannelId = event?.headers?.["x-goog-channel-id"];
      if (!channelIds.includes(incomingChannelId)) {
        console.log(
          `Unexpected channel ID ${incomingChannelId}. This likely means there are multiple, older subscriptions active.`,
        );
        return;
      }

      // Check that resource state === exists
      const state = event?.headers?.["x-goog-resource-state"];
      switch (state) {
      case "exists":
        // there's something to emit, so keep going
        break;
      case "not_exists":
        console.log("Resource does not exist. Exiting.");
        return;
      case "sync":
        console.log("New channel created");
        return;
      default:
        console.log(`Unknown state: ${state}`);
        return;
      }

      // Fetch and emit events
      for (const calendarId of this.calendarIds) {
        const syncToken = this.db.get(`${calendarId}.nextSyncToken`);
        let nextSyncToken = null;
        let nextPageToken = null;
        while (!nextSyncToken) {
          const listConfig = {
            calendarId,
            syncToken,
            pageToken: nextPageToken,
          };
          const {
            data: syncData = {},
            status: syncStatus,
          } = await this.googleCalendar.list(listConfig);
          if (syncStatus === 410) {
            console.log("Sync token invalid, resyncing");
            nextSyncToken = await this.googleCalendar.fullSync(this.calendarId);
            break;
          }
          nextPageToken = syncData.nextPageToken;
          nextSyncToken = syncData.nextSyncToken;

          const { items: events = [] } = syncData;
          events
            .filter(this.isEventRelevant, this)
            .forEach((event) => {
              const { status } = event;
              if (status === "cancelled") {
                console.log("Event cancelled. Exiting.");
                return;
              }
              const meta = this.generateMeta(event);
              this.$emit(event, meta);
            });
        }

        this.db.set(`${calendarId}.nextSyncToken`, nextSyncToken);
      }
    }
  },
};
