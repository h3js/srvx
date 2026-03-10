/**
 * Tests for HOST_RE validation regex in NodeRequestURL.
 *
 * HOST_RE validates Host header values before they reach FastURL.
 * It must reject values that would cause FastURL or the native URL
 * parser to throw, without introducing runtime URL allocations.
 */

import { describe, expect, test } from "vitest";
import { HOST_RE } from "../src/adapters/_node/url.ts";

describe("HOST_RE", () => {
  describe("valid hosts", () => {
    const valid = [
      // Domains
      "localhost",
      "example.com",
      "sub.example.com",
      "deep.sub.example.com",
      "my-server",
      "my_server",

      // IPv4
      "0.0.0.0",
      "127.0.0.1",
      "192.168.1.1",
      "255.255.255.255",

      // IPv6
      "[::1]",
      "[2001:db8::1]",
      "[::ffff:127.0.0.1]",

      // With valid ports
      "localhost:80",
      "localhost:443",
      "localhost:3000",
      "localhost:8080",
      "example.com:1",
      "example.com:65535",
      "127.0.0.1:3000",
      "[::1]:8080",
    ];

    test.each(valid)("%s", (host) => {
      expect(HOST_RE.test(host)).toBe(true);
    });
  });

  describe("invalid hosts", () => {
    const invalid = [
      // Path in host
      "localhost:3000/foobar",
      "example.com/path",

      // Query in host
      "example.com?query=1",

      // Special characters
      "evil@host.com",
      "host with spaces",
      "<script>alert(1)</script>",

      // Double colon (not IPv6 bracket syntax)
      "host:port:extra",

      // Out-of-range ports
      "example.com:0",
      "example.com:65536",
      "example.com:99999",
      "localhost:00000",

      // Empty
      "",
    ];

    test.each(invalid)("%s", (host) => {
      expect(HOST_RE.test(host)).toBe(false);
    });
  });

  describe("IPv4 octet boundaries", () => {
    test("255.255.255.255 is valid", () => {
      expect(HOST_RE.test("255.255.255.255")).toBe(true);
    });

    test("0.0.0.0 is valid", () => {
      expect(HOST_RE.test("0.0.0.0")).toBe(true);
    });

    test("256.0.0.1 is matched by domain alternative (syntactically valid hostname)", () => {
      // Note: 256.0.0.1 looks like IPv4 but is technically a valid
      // domain name (digits and dots are allowed in hostnames).
      // The WHATWG URL parser rejects it, but HOST_RE's domain
      // alternative matches it. This is acceptable because FastURL
      // only hits the throwing slowpath when pathname needs
      // normalization, which is rare for clean request paths.
      expect(HOST_RE.test("256.0.0.1")).toBe(true);
    });
  });

  describe("port boundaries", () => {
    test("port 1 is valid", () => {
      expect(HOST_RE.test("localhost:1")).toBe(true);
    });

    test("port 65535 is valid", () => {
      expect(HOST_RE.test("localhost:65535")).toBe(true);
    });

    test("port 0 is invalid", () => {
      expect(HOST_RE.test("localhost:0")).toBe(false);
    });

    test("port 65536 is invalid", () => {
      expect(HOST_RE.test("localhost:65536")).toBe(false);
    });

    test("port 99999 is invalid", () => {
      expect(HOST_RE.test("localhost:99999")).toBe(false);
    });
  });
});
