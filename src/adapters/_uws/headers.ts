import { splitSetCookieString } from "cookie-es";
import { kNodeInspect } from "../_node/_common.ts";

import type { UWSServerRequest, UWSServerResponse } from "../../types.ts";

export const UWSRequestHeaders: {
  new (req: UWSServerRequest): globalThis.Headers;
} = /* @__PURE__ */ (() => {
  const _Headers = class Headers implements globalThis.Headers {
    _req: UWSServerRequest;

    constructor(req: UWSServerRequest) {
      this._req = req;
    }

    append(_name: string, _value: string): void {
      throw new Error("UWSRequestHeaders are immutable.");
    }

    delete(_name: string): void {
      throw new Error("UWSRequestHeaders are immutable.");
    }

    get(name: string): string | null {
      const value = this._req.getHeader(validateHeader(name));
      return value === "" ? null : value;
    }

    getSetCookie(): string[] {
      const setCookie = this.get("set-cookie");
      if (!setCookie) {
        return [];
      }
      return splitSetCookieString(setCookie);
    }

    has(name: string): boolean {
      return this.get(validateHeader(name)) !== null;
    }

    set(_name: string, _value: string): void {
      throw new Error("UWSRequestHeaders are immutable.");
    }

    get count(): number {
      // Bun-specific addon
      throw new Error("Method not implemented.");
    }

    getAll(name: "set-cookie" | "Set-Cookie"): string[] {
      const lowerName = name.toLowerCase();
      const val = this._req.getHeader(lowerName);
      if (lowerName === "set-cookie") {
        return val ? splitSetCookieString(val) : [];
      }
      return val === "" ? [] : val.split(", ");
    }

    toJSON(): Record<string, string> {
      const result: Record<string, string> = {};
      this._req["forEach"]((key, value) => {
        result[key] = value;
      });
      return result;
    }

    forEach(
      cb: (value: string, key: string, parent: Headers) => void,
      thisArg?: object,
    ): void {
      this._req["forEach"]((key, value) => {
        cb.call(thisArg, value, key, this);
      });
    }

    *entries(): HeadersIterator<[string, string]> {
      const entries: [string, string][] = [];
      this._req["forEach"]((k, v) => {
        entries.push([k, v]);
      });
      yield* entries;
    }

    *keys(): HeadersIterator<string> {
      const keys: string[] = [];
      this._req["forEach"]((k) => {
        keys.push(k);
      });
      yield* keys;
    }

    *values(): HeadersIterator<string> {
      const values: string[] = [];
      this._req["forEach"]((_, v) => {
        values.push(v);
      });
      yield* values;
    }

    [Symbol.iterator](): HeadersIterator<[string, string]> {
      return this.entries();
    }

    get [Symbol.toStringTag]() {
      return "Headers";
    }

    [kNodeInspect]() {
      return Object.fromEntries(this.entries());
    }
  };

  Object.setPrototypeOf(_Headers.prototype, globalThis.Headers.prototype);

  return _Headers;
})();

export const UWSResponseHeaders: {
  new (res: UWSServerResponse): globalThis.Headers;
} = /* @__PURE__ */ (() => {
  const _Headers = class Headers implements globalThis.Headers {
    _res: UWSServerResponse;
    _headers: Record<string, string | string[]> = {};

    constructor(res: UWSServerResponse) {
      this._res = res;
    }

    append(name: string, value: string): void {
      name = validateHeader(name);
      const current = this._headers[name];
      if (current) {
        if (Array.isArray(current)) {
          current.push(value);
        } else {
          this._headers[name] = [current, value];
        }
      } else {
        this._headers[name] = value;
      }
      this._apply();
    }

    delete(name: string): void {
      name = validateHeader(name);
      delete this._headers[name];
      this._apply();
    }

    get(name: string): string | null {
      const value = this._headers[validateHeader(name)];
      if (value === undefined) {
        return null;
      }
      return Array.isArray(value) ? value.join(", ") : value;
    }

    getSetCookie(): string[] {
      const setCookie = this._headers["set-cookie"];
      if (!setCookie) {
        return [];
      }
      return Array.isArray(setCookie) ? setCookie : [setCookie];
    }

    has(name: string): boolean {
      return this._headers[validateHeader(name)] !== undefined;
    }

    set(name: string, value: string): void {
      this._headers[validateHeader(name)] = value;
      this._apply();
    }

    get count(): number {
      // Bun-specific addon
      throw new Error("Method not implemented.");
    }

    getAll(_name: "set-cookie" | "Set-Cookie"): string[] {
      // Bun-specific addon
      throw new Error("Method not implemented.");
    }

    _apply() {
      for (const [key, value] of Object.entries(this._headers)) {
        if (Array.isArray(value)) {
          // uws allows multiple headers with same name
          for (const v of value) {
            this._res.writeHeader(key, v);
          }
        } else {
          this._res.writeHeader(key, value);
        }
      }
    }

    toJSON(): Record<string, string> {
      const result: Record<string, string> = {};
      for (const key in this._headers) {
        result[key] = this.get(key)!;
      }
      return result;
    }

    forEach(
      cb: (value: string, key: string, parent: Headers) => void,
      thisArg?: object,
    ): void {
      for (const key in this._headers) {
        cb.call(thisArg, this.get(key)!, key, this);
      }
    }

    *entries(): HeadersIterator<[string, string]> {
      for (const key in this._headers) {
        yield [key, this.get(key)!];
      }
    }

    *keys(): HeadersIterator<string> {
      for (const key in this._headers) {
        yield key;
      }
    }

    *values(): HeadersIterator<string> {
      for (const key in this._headers) {
        yield this.get(key)!;
      }
    }

    [Symbol.iterator](): HeadersIterator<[string, string]> {
      return this.entries();
    }

    get [Symbol.toStringTag]() {
      return "Headers";
    }

    [kNodeInspect]() {
      return this._headers;
    }
  };

  Object.setPrototypeOf(_Headers.prototype, globalThis.Headers.prototype);

  return _Headers;
})();

function validateHeader(name: string): string {
  if (name[0] === ":") {
    throw new TypeError(`${JSON.stringify(name)} is an invalid header name.`);
  }
  return name.toLowerCase();
}
