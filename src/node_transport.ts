import {
  render,
  Transport,
  Deferred,
  deferred,
  DataBuffer,
  extractProtocolMessage,
  INFO,
  checkOptions,
  ErrorCode,
  NatsError,
} from "./nats-base-client";

import { ConnectionOptions } from "./nats-base-client";
import { Socket, createConnection } from "net";
import { extend } from "../nats-base-client/util";
import { connect as tlsConnect, TLSSocket } from "tls";

const VERSION = "2.0.0-0";
const LANG = "nats.js";

export class NodeTransport implements Transport {
  socket: Socket;
  version: string;
  lang: string;
  yields: Uint8Array[] = [];
  signal: Deferred<void> = deferred<void>();
  closedNotification: Deferred<void | Error> = deferred();
  options!: ConnectionOptions;
  connected = false;
  done = false;

  constructor() {
    this.lang = LANG;
    this.version = VERSION;
  }

  async connect(
    hp: { hostname: string; port: number },
    options: ConnectionOptions,
  ): Promise<void> {
    this.options = options;
    try {
      this.socket = await this.dial(hp);
      const info = await this.peekInfo();
      checkOptions(info, options);
      // @ts-ignore
      const { tls_required } = info;
      if (tls_required) {
        this.socket = await this.startTLS();
      }
      this.connected = true;
      this.setupHandlers();
      this.signal.resolve();
      return Promise.resolve();
    } catch (err) {
      const { code } = err;
      err = code === "ECONNREFUSED"
        ? NatsError.errorForCode(ErrorCode.CONNECTION_REFUSED, err)
        : err;
      return Promise.reject(err);
    }
  }

  dial(hp: { hostname: string; port: number }): Promise<Socket> {
    const d = deferred<Socket>();
    let dialError: Error;
    const socket = createConnection(hp.port, hp.hostname, () => {
      d.resolve(socket);
      socket.removeAllListeners();
    });
    socket.on("error", (err) => {
      dialError = err;
    });
    socket.on("close", () => {
      socket.removeAllListeners();
      d.reject(dialError);
    });
    socket.setNoDelay(true);
    return d;
  }

  get isClosed(): boolean {
    return this.done;
  }

  close(err?: Error): Promise<void> {
    return this._closed(err, false);
  }

  peekInfo(): Promise<object> {
    const d = deferred<object>();
    let peekError: Error;
    this.socket.on("data", (frame) => {
      this.yields.push(frame);
      const t = DataBuffer.concat(...this.yields);
      const pm = extractProtocolMessage(t);
      if (pm) {
        try {
          const m = INFO.exec(pm);
          if (!m) {
            throw new Error("unexpected response from server");
          }
          const info = JSON.parse(m[1]);
          d.resolve(info);
        } catch (err) {
          d.reject(err);
        } finally {
          this.socket.removeAllListeners();
        }
      }
    });
    this.socket.on("error", (err) => {
      peekError = err;
    });
    this.socket.on("close", () => {
      this.socket.removeAllListeners();
      d.reject(peekError);
    });

    return d;
  }

  startTLS(): Promise<TLSSocket> {
    const d = deferred<TLSSocket>();
    let tlsError: Error;
    let tlsOpts = { socket: this.socket };
    if (typeof this.options.tls === "object") {
      tlsOpts = extend(tlsOpts, this.options.tls);
    }
    const tlsSocket = tlsConnect(tlsOpts, () => {
      tlsSocket.removeAllListeners();
      d.resolve(tlsSocket);
    });
    tlsSocket.on("error", (err) => {
      tlsError = err;
    });
    tlsSocket.on("close", () => {
      tlsSocket.removeAllListeners();
      d.reject(tlsError);
    });
    return d;
  }

  setupHandlers() {
    let connError: Error;
    this.socket.on("data", (frame: Uint8Array) => {
      this.yields.push(frame);
      return this.signal.resolve();
    });
    this.socket.on("error", (err) => {
      connError = err;
    });
    this.socket.on("close", () => {
      // if socket notified a close, any write will fail
      this.socket = undefined;
      this._closed(connError, false);
    });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this.iterate();
  }

  async *iterate(): AsyncIterableIterator<Uint8Array> {
    while (true) {
      await this.signal;
      while (this.yields.length > 0) {
        const frame = this.yields.shift();
        if (frame) {
          if (this.options.debug) {
            console.info(`> ${render(frame)}`);
          }
          yield frame;
        }
      }
      if (this.done) {
        break;
      } else {
        this.signal = deferred();
      }
    }
  }

  disconnect(): void {
    this._closed(undefined, true).then().catch();
  }

  isEncrypted(): boolean {
    return this.socket instanceof TLSSocket;
  }

  send(frame: Uint8Array): Promise<void> {
    if (this.isClosed) {
      return Promise.resolve();
    }
    if (this.options.debug) {
      console.info(`< ${render(frame)}`);
    }
    const d = deferred<void>();
    this.socket.write(frame, (err) => {
      if (err) {
        return d.reject(err);
      }
      return d.resolve();
    });
    return d;
  }

  private async _closed(err?: Error, internal: boolean = true): Promise<void> {
    // if this connection didn't succeed, then ignore it.
    if (!this.connected) return;
    if (this.done) return;
    if (!err && this.socket) {
      try {
        // this is a noop for the server, but gives us a place to hang
        // a close and ensure that we sent all before closing
        await this.send(new TextEncoder().encode("+OK\r\n"));
      } catch (err) {
        if (this.options.debug) {
          console.log("transport close terminated with an error", err);
        }
      }
    }
    try {
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.destroy();
      }
    } catch (err) {}

    this.done = true;
    this.closedNotification.resolve(err);
  }

  closed(): Promise<void | Error> {
    return this.closedNotification;
  }
}