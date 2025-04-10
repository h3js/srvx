import type NodeHttp from "node:http";
import { splitSetCookieString } from "cookie-es";
import { kNodeInspect } from "./_common.ts";

export const NodeRequestHeaders = /* @__PURE__ */ (() => {
  const _Headers = class Headers implements globalThis.Headers {
    node: { req: NodeHttp.IncomingMessage; res?: NodeHttp.ServerResponse };

    constructor(nodeCtx: {
      req: NodeHttp.IncomingMessage;
      res?: NodeHttp.ServerResponse;
    }) {
      this.node = nodeCtx;
    }

    append(name: string, value: string): void {
      name = name.toLowerCase();
      const _headers = this.node.req.headers;
      const _current = _headers[name];
      if (_current) {
        if (Array.isArray(_current)) {
          _current.push(value);
        } else {
          _headers[name] = [_current as string, value];
        }
      } else {
        _headers[name] = value;
      }
    }

    delete(name: string): void {
      name = name.toLowerCase();
      this.node.req.headers[name] = undefined;
    }

    get(name: string): string | null {
      name = name.toLowerCase();
      const rawValue = this.node.req.headers[name];
      if (rawValue === undefined) {
        return null;
      }
      return _normalizeValue(this.node.req.headers[name]);
    }

    getSetCookie(): string[] {
      const setCookie = this.node.req.headers["set-cookie"];
      if (!setCookie || setCookie.length === 0) {
        return [];
      }
      return splitSetCookieString(setCookie);
    }

    has(name: string): boolean {
      name = name.toLowerCase();
      return !!this.node.req.headers[name];
    }

    set(name: string, value: string): void {
      name = name.toLowerCase();
      this.node.req.headers[name] = value;
    }

    get count(): number {
      // Bun-specific addon
      throw new Error("Method not implemented.");
    }

    getAll(_name: "set-cookie" | "Set-Cookie"): string[] {
      // Bun-specific addon
      throw new Error("Method not implemented.");
    }

    toJSON(): Record<string, string> {
      const _headers = this.node.req.headers;
      const result: Record<string, string> = {};
      for (const key in _headers) {
        if (_headers[key]) {
          result[key] = _normalizeValue(_headers[key]);
        }
      }
      return result;
    }

    forEach(
      cb: (value: string, key: string, parent: Headers) => void,
      thisArg?: any,
    ): void {
      const _headers = this.node.req.headers;
      for (const key in _headers) {
        if (_headers[key]) {
          cb.call(
            thisArg,
            _normalizeValue(_headers[key]),
            key,
            this as unknown as Headers,
          );
        }
      }
    }

    *entries(): HeadersIterator<[string, string]> {
      const _headers = this.node.req.headers;
      for (const key in _headers) {
        yield [key, _normalizeValue(_headers[key])];
      }
    }

    *keys(): HeadersIterator<string> {
      const keys = Object.keys(this.node.req.headers);
      for (const key of keys) {
        yield key;
      }
    }

    *values(): HeadersIterator<string> {
      const values = Object.values(this.node.req.headers);
      for (const value of values) {
        yield _normalizeValue(value);
      }
    }

    [Symbol.iterator](): HeadersIterator<[string, string]> {
      return this.entries()[Symbol.iterator]();
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

export const NodeResponseHeaders = /* @__PURE__ */ (() => {
  const _Headers = class Headers implements globalThis.Headers {
    node: { req?: NodeHttp.IncomingMessage; res: NodeHttp.ServerResponse };

    constructor(nodeCtx: {
      req?: NodeHttp.IncomingMessage;
      res: NodeHttp.ServerResponse;
    }) {
      this.node = nodeCtx;
    }

    append(name: string, value: string): void {
      this.node.res.appendHeader(name, value);
    }

    delete(name: string): void {
      this.node.res.removeHeader(name);
    }

    get(name: string): string | null {
      const rawValue = this.node.res.getHeader(name);
      if (rawValue === undefined) {
        return null;
      }
      return _normalizeValue(rawValue);
    }

    getSetCookie(): string[] {
      const setCookie = _normalizeValue(this.node.res.getHeader("set-cookie"));
      if (!setCookie) {
        return [];
      }
      return splitSetCookieString(setCookie);
    }

    has(name: string): boolean {
      return this.node.res.hasHeader(name);
    }

    set(name: string, value: string): void {
      this.node.res.setHeader(name, value);
    }

    get count(): number {
      // Bun-specific addon
      throw new Error("Method not implemented.");
    }

    getAll(_name: "set-cookie" | "Set-Cookie"): string[] {
      // Bun-specific addon
      throw new Error("Method not implemented.");
    }

    toJSON(): Record<string, string> {
      const _headers = this.node.res.getHeaders();
      const result: Record<string, string> = {};
      for (const key in _headers) {
        if (_headers[key]) {
          result[key] = _normalizeValue(_headers[key]);
        }
      }
      return result;
    }

    forEach(
      cb: (value: string, key: string, parent: Headers) => void,
      thisArg?: any,
    ): void {
      const _headers = this.node.res.getHeaders();
      for (const key in _headers) {
        if (_headers[key]) {
          cb.call(
            thisArg,
            _normalizeValue(_headers[key]),
            key,
            this as unknown as Headers,
          );
        }
      }
    }

    *entries(): HeadersIterator<[string, string]> {
      const _headers = this.node.res.getHeaders();
      for (const key in _headers) {
        yield [key, _normalizeValue(_headers[key])];
      }
    }

    *keys(): HeadersIterator<string> {
      const keys = this.node.res.getHeaderNames();
      for (const key of keys) {
        yield key;
      }
    }

    *values(): HeadersIterator<string> {
      const values = Object.values(this.node.res.getHeaders());
      for (const value of values) {
        yield _normalizeValue(value);
      }
    }

    [Symbol.iterator](): HeadersIterator<[string, string]> {
      return this.entries()[Symbol.iterator]();
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

function _normalizeValue(
  value: string | string[] | number | undefined,
): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return typeof value === "string" ? value : String(value ?? "");
}
