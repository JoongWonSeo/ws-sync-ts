// Redux Store that also has an associated remote persistently connected over a WebSocket
import { configureStore } from "@reduxjs/toolkit";
import fileDownload from "js-file-download";
import { v4 as uuid } from "uuid";

console.log(configureStore);
console.log(fileDownload);
console.log(uuid);

type SessionStoreOptions = SessionConfig & {
  reducer: Record<string, any>;
  autoconnect?: boolean;
  wsAuth?: boolean;
};

export const createSessionStore = ({
  reducer,
  autoconnect = false,
  wsAuth = false,
  ...sessionConfig
}: SessionStoreOptions) => {
  // ========== Create Redux Store ========== //
  const store = configureStore({
    reducer: reducer,
  });

  // ========== Create WS Session ========== //
  const session = new Session({ store, ...sessionConfig });

  if (wsAuth) {
    let userId = localStorage.getItem("_USER_ID");
    let sessionId = sessionStorage.getItem("_SESSION_ID");

    session?.registerEvent("_REQUEST_USER_SESSION", () => {
      let u = userId;
      let s = sessionId;
      if (userId === null) {
        u = uuid();
        localStorage.setItem("_USER_ID", u);
        console.log("generated new user id", u);
      }
      if (sessionId === null) {
        s = uuid();
        sessionStorage.setItem("_SESSION_ID", s);
        console.log("generated new session id", s);
      }
      session.send("_USER_SESSION", { user: u, session: s });
    });
  }

  if (autoconnect) {
    session.connect();
  }

  return session;
};

type SessionConfig = {
  url: string;
  label?: string;
  toast?: any;
  store?: any;
  minRetryInterval?: number;
  maxRetryInterval?: number;
  onConnectionChange?: (arg0: boolean) => void;
};

export class Session {
  // ========== Public Properties ========== //
  url: string;
  label: string;
  ws: WebSocket | null = null;

  isConnected: boolean = false;
  onConnectionChange?: (arg0: boolean) => void;
  minRetryInterval: number;
  maxRetryInterval: number;
  currentRetryInterval: number;
  toast: any;
  store: any;

  // ========== Private Properties ========== //
  private eventHandlers: { [event: string]: (data: any) => void } = {};
  private initHandlers: { [key: string]: () => void } = {};
  private binaryHandler: ((data: any) => void) | null = null;
  private binData: any | null = null; // metadata for the next binary message
  private retryTimeout: ReturnType<typeof setTimeout> | null = null; // scheduled retry
  private autoReconnect: boolean = true;

  // ========== Constructor ========== //
  constructor({
    url,
    label = "Server",
    toast = null,
    store = null,
    minRetryInterval = 250,
    maxRetryInterval = 10000,
    onConnectionChange = undefined,
  }: SessionConfig) {
    this.url = url;
    this.label = label;
    this.toast = toast;
    this.store = store;
    this.minRetryInterval = minRetryInterval;
    this.maxRetryInterval = maxRetryInterval;
    this.currentRetryInterval = minRetryInterval;
    this.onConnectionChange = onConnectionChange;
  }

  registerEvent(event: string, callback: (data: any) => void) {
    if (event in this.eventHandlers)
      throw new Error(`already subscribed to ${event}`);
    this.eventHandlers[event] = callback;
  }

  deregisterEvent(event: string) {
    if (!(event in this.eventHandlers))
      throw new Error(`not subscribed to ${event}`);
    delete this.eventHandlers[event];
  }

  registerInit(key: string, callback: () => void) {
    if (key in this.initHandlers) throw new Error(`already registered`);
    this.initHandlers[key] = callback;
  }

  deregisterInit(key: string) {
    if (!(key in this.initHandlers)) throw new Error(`not registered`);
    delete this.initHandlers[key];
  }

  registerBinary(callback: (data: any) => void) {
    if (this.binaryHandler !== null) throw new Error(`already registered`);
    this.binaryHandler = callback;
  }

  deregisterBinary() {
    if (this.binaryHandler === null) throw new Error(`not registered`);
    this.binaryHandler = null;
  }

  send(event: string, data: any) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.toast?.error(`${this.label}: Sending while not connected!`);
      return;
    }

    this.ws?.send(
      JSON.stringify({
        type: event,
        data: data,
      })
    );
  }

  sendBinary(event: string, metadata: any, data: ArrayBuffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.toast?.error(`${this.label}: Sending while not connected!`);
      return;
    }

    this.ws?.send(
      JSON.stringify({
        type: "_BIN_META",
        data: {
          type: event,
          metadata: metadata,
        },
      })
    );
    this.ws?.send(data);
  }

  connect() {
    this.toast?.info(`Connecting to ${this.label}...`);
    this.ws = new WebSocket(this.url);
    this.autoReconnect = true;

    this.ws.onopen = () => {
      this.toast?.success(`Connected to ${this.label}!`);
      this.isConnected = true;
      if (this.onConnectionChange) this.onConnectionChange(this.isConnected);
      this.currentRetryInterval = this.minRetryInterval;
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      if (this.onConnectionChange) this.onConnectionChange(this.isConnected);
      if (this.autoReconnect) {
        this.toast?.warning(
          `Disconnected from ${this.label}: Retrying in ${
            this.currentRetryInterval / 1000
          } seconds...`
        );
        this.retryTimeout = setTimeout(() => {
          // skip if we've already reconnected or deleted
          if (this !== null && this.url && !this.isConnected) {
            this.connect();
          }
        }, this.currentRetryInterval);
        this.currentRetryInterval = Math.min(
          this.currentRetryInterval * 2,
          this.maxRetryInterval
        );
      } else {
        this.toast?.warning(`Disconnected from ${this.label}!`);
      }
    };

    this.ws.onerror = (err) => {
      console.error("Socket encountered error: ", err, "Closing socket");
      this.toast?.error(`${this.label}: Socket Error: ${err}`);
      this.ws?.close();
    };

    this.ws.onmessage = (e) => {
      this.handleReceiveEvent(e);
    };

    return () => {
      this.disconnect();
    };
  }

  disconnect() {
    this.autoReconnect = false;
    this.ws?.close();
    if (this.onConnectionChange) this.onConnectionChange(false);
    if (this.ws !== null) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws = null;
    }
    if (this.retryTimeout !== null) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
  }

  handleReceiveEvent(e: MessageEvent) {
    if (typeof e.data === "string") {
      // json message
      const event = JSON.parse(e.data);
      if (event.type == "_DISCONNECT") {
        this.disconnect();
        this.toast?.loading(`${this.label}: ${event.data}`, {
          duration: 10000000,
        });
        return;
      } else if (event.type == "_DOWNLOAD") {
        // decode the base64 data and download it
        const { filename, data } = event.data;
        fetch(`data:application/octet-stream;base64,${data}`)
          .then((res) => res.blob())
          .then((blob) => fileDownload(blob, filename));
      } else if (event.type == "_BIN_META") {
        // the next message will be binary, save the metadata
        if (this.binData !== null) console.log(`overwriting bytes metadata`);
        this.binData = event.data;
      } else if (event.type in this.eventHandlers) {
        this.eventHandlers[event.type](event.data);
      } else {
        console.log(`unhandled event: ${event.type}`);
      }
    } else {
      // binary message
      if (this.binData !== null) {
        if (this.binData.type in this.eventHandlers)
          this.eventHandlers[this.binData.type]({
            data: e.data,
            ...this.binData.metadata,
          });
        else console.log(`no handler for binary event: ${this.binData.type}`);
        // clear the metadata since we've handled it
        this.binData = null;
      } else if (this.binaryHandler !== null) this.binaryHandler(e.data);
      else console.log(`unhandled binary message`);
    }
  }
}
