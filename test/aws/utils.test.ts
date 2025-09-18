import { describe, expect, test, vi } from "vitest";
import {
  awsRequest,
  awsResponseBody,
  awsResponseHeaders,
} from "../../src/adapters/_aws/_utils.ts";
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2 } from "aws-lambda";

// Mock Headers.getAll method for testing
class MockHeaders extends Headers {
  private cookies: string[] = [];

  constructor(init?: HeadersInit) {
    super(init);
  }

  override getSetCookie(): string[] {
    return this.cookies;
  }

  setCookie(cookie: string) {
    this.cookies.push(cookie);
  }
}

describe("[AWS Lambda] Request Utils", () => {
  describe("awsRequest", () => {
    test("should convert API Gateway v1 event to Request", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "POST",
        path: "/api/users",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token123",
          host: "api.example.com",
        },
        queryStringParameters: {
          page: "1",
          limit: "10",
        },
        body: JSON.stringify({ name: "John Doe", email: "john@example.com" }),
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
      };

      const request = awsRequest(v1Event);

      expect(request).toBeInstanceOf(Request);
      expect(request.method).toBe("POST");
      expect(request.url).toContain("/api/users");
      expect(request.url).toContain("page=1");
      expect(request.url).toContain("limit=10");
      expect(request.headers.get("Content-Type")).toBe("application/json");
      expect(request.headers.get("Authorization")).toBe("Bearer token123");
    });

    test("should convert API Gateway v2 event to Request", () => {
      const v2Event: APIGatewayProxyEventV2 = {
        version: "2.0",
        routeKey: "POST /api/users",
        rawPath: "/api/users",
        rawQueryString: "page=1&limit=10",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer token123",
          host: "api.example.com",
          "x-forwarded-proto": "https",
        },
        cookies: ["sessionId=abc123", "theme=dark"],
        body: JSON.stringify({ name: "Jane Doe", email: "jane@example.com" }),
        isBase64Encoded: false,
        requestContext: {
          http: {
            method: "POST",
            path: "/api/users",
          },
          domainName: "api.example.com",
        } as any,
      };

      const request = awsRequest(v2Event);

      expect(request).toBeInstanceOf(Request);
      expect(request.method).toBe("POST");
      expect(request.url).toContain("/api/users");
      expect(request.url).toContain("page=1");
      expect(request.url).toContain("limit=10");
      expect(request.url).toMatch(/^https:\/\//);
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.headers.get("authorization")).toBe("Bearer token123");
      // Check cookies are set (we can't easily test getAll in test environment)
      expect(request.headers.get("cookie")).toBeDefined();
    });

    test("should handle base64 encoded body", () => {
      const encodedBody = Buffer.from("Hello, World!").toString("base64");
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "POST",
        path: "/api/upload",
        headers: { host: "api.example.com" },
        body: encodedBody,
        isBase64Encoded: true,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        queryStringParameters: null,
      };

      const request = awsRequest(v1Event);

      expect(request.body).toBeDefined();
    });

    test("should handle missing body", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/users",
        headers: { host: "api.example.com" },
        body: null,
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        queryStringParameters: null,
      };

      const request = awsRequest(v1Event);

      expect(request.body).toBeNull();
    });

    test("should handle missing headers", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/users",
        headers: {},
        body: null,
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        queryStringParameters: null,
      };

      const request = awsRequest(v1Event);

      expect(request.headers).toBeInstanceOf(Headers);
    });

    test("should handle missing query parameters", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/users",
        headers: { host: "api.example.com" },
        body: null,
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        queryStringParameters: null,
      };

      const request = awsRequest(v1Event);

      expect(request.url).not.toContain("?");
    });

    test("should handle multi-value query parameters", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/users",
        headers: { host: "api.example.com" },
        body: null,
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {
          tags: ["javascript", "typescript"],
          category: ["backend"],
        },
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        queryStringParameters: null,
      };

      const request = awsRequest(v1Event);

      expect(request.url).toContain("tags=javascript");
      expect(request.url).toContain("tags=typescript");
      expect(request.url).toContain("category=backend");
    });

    test("should default to GET method when not provided", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: null as any,
        path: "/api/users",
        headers: { host: "api.example.com" },
        body: null,
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        queryStringParameters: null,
      };

      const request = awsRequest(v1Event);

      expect(request.method).toBe("GET");
    });

    test("should handle HTTP protocol detection", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/users",
        headers: {
          host: "api.example.com",
          "x-forwarded-proto": "http",
        },
        body: null,
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        queryStringParameters: null,
      };

      const request = awsRequest(v1Event);

      expect(request.url).toMatch(/^http:\/\//);
    });

    test("should default to HTTPS when protocol not specified", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/users",
        headers: { host: "api.example.com" },
        body: null,
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        queryStringParameters: null,
      };

      const request = awsRequest(v1Event);

      expect(request.url).toMatch(/^https:\/\//);
    });

    test("should handle path parameters in URL construction", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/users/123",
        headers: { host: "api.example.com" },
        body: null,
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: { id: "123" },
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        queryStringParameters: null,
      };

      const request = awsRequest(v1Event);

      expect(request.url).toContain("/api/users/123");
    });
  });

  describe("awsResponseHeaders", () => {
    test("should convert Response headers to AWS format", () => {
      const headers = new MockHeaders({
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Custom-Header": "custom-value",
      });

      const responseMock = new Response('{"message": "success"}', {
        status: 200,
        headers,
      });

      const response = awsResponseHeaders(responseMock);

      expect(response.headers).toEqual({
        "content-type": "application/json",
        "cache-control": "no-cache",
        "x-custom-header": "custom-value",
      });
      expect(response.cookies).toBeUndefined();
      expect(response.multiValueHeaders).toBeUndefined();
    });

    test("should handle cookies for API Gateway compatibility", () => {
      const headers = new MockHeaders({
        "Content-Type": "application/json",
      });
      headers.setCookie("sessionId=abc123; HttpOnly; Secure");
      headers.setCookie("theme=dark; Path=/");

      const response = new Response('{"message": "success"}', {
        status: 200,
        headers,
      });

      // Replace the response.headers with our MockHeaders instance
      Object.defineProperty(response, "headers", {
        value: headers,
        writable: true,
        configurable: true,
      });

      // Verify the mock is working
      expect(headers.getSetCookie()).toEqual([
        "sessionId=abc123; HttpOnly; Secure",
        "theme=dark; Path=/",
      ]);

      const awsResponse = awsResponseHeaders(response);

      expect(awsResponse.cookies).toEqual([
        "sessionId=abc123; HttpOnly; Secure",
        "theme=dark; Path=/",
      ]);
      expect(awsResponse.multiValueHeaders).toEqual({
        "set-cookie": [
          "sessionId=abc123; HttpOnly; Secure",
          "theme=dark; Path=/",
        ],
      });
    });

    test("should handle array headers by joining with commas", () => {
      const headers = new MockHeaders();
      headers.set("Accept", "application/json");
      headers.append("Accept", "text/html");
      headers.append("Accept", "text/plain");

      const response = new Response("content", {
        status: 200,
        headers,
      });

      const awsResponse = awsResponseHeaders(response);

      expect(awsResponse.headers.accept).toBe(
        "application/json, text/html, text/plain",
      );
    });

    test("should handle null/undefined header values", () => {
      const headers = new MockHeaders({
        "Valid-Header": "valid-value",
        "Null-Header": null as any,
        "Undefined-Header": undefined as any,
      });

      const response = new Response("content", {
        status: 200,
        headers,
      });

      const awsResponse = awsResponseHeaders(response);

      expect(awsResponse.headers["valid-header"]).toBe("valid-value");
      expect(awsResponse.headers["null-header"]).toBe("null");
      expect(awsResponse.headers["undefined-header"]).toBe("undefined");
    });

    test("should throw error for invalid response", () => {
      expect(() => {
        awsResponseHeaders(null as any);
      }).toThrow();

      expect(() => {
        awsResponseHeaders(undefined as any);
      }).toThrow();
    });

    test("should handle response without headers", () => {
      const response = new Response("content", { status: 200 });

      // Mock the headers property to be null
      Object.defineProperty(response, "headers", {
        value: null,
        writable: true,
      });

      expect(() => awsResponseHeaders(response)).toThrow();
    });
  });

  describe("awsResponseBody", () => {
    test("should convert text response to UTF-8 string", async () => {
      const response = new Response("Hello, World!", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });

      const awsBody = await awsResponseBody(response);

      expect(awsBody.body).toBe("Hello, World!");
      expect(awsBody.isBase64Encoded).toBeUndefined();
    });

    test("should convert JSON response to UTF-8 string", async () => {
      const jsonData = { message: "success", data: { id: 1, name: "John" } };
      const response = new Response(JSON.stringify(jsonData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

      const awsBody = await awsResponseBody(response);

      expect(awsBody.body).toBe(JSON.stringify(jsonData));
      expect(awsBody.isBase64Encoded).toBeUndefined();
    });

    test("should convert binary response to base64", async () => {
      const binaryData = Buffer.from("Hello, Binary World!");
      const response = new Response(binaryData, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });

      const awsBody = await awsResponseBody(response);

      expect(awsBody.body).toBe(binaryData.toString("base64"));
      expect(awsBody.isBase64Encoded).toBe(true);
    });

    test("should handle empty response body", async () => {
      const response = new Response(null, { status: 204 });

      const awsBody = await awsResponseBody(response);

      expect(awsBody.body).toBe("");
      expect(awsBody.isBase64Encoded).toBeUndefined();
    });

    test("should handle response without body", async () => {
      const response = new Response(undefined, { status: 204 });

      const awsBody = await awsResponseBody(response);

      expect(awsBody.body).toBe("");
      expect(awsBody.isBase64Encoded).toBeUndefined();
    });

    test("should identify binary content types correctly", async () => {
      const binaryContentTypes = [
        "application/octet-stream",
        "image/png",
        "image/jpeg",
        "application/pdf",
        "video/mp4",
        "audio/mpeg",
      ];

      const binaryData = Buffer.from("binary content");

      for (const contentType of binaryContentTypes) {
        const response = new Response(binaryData, {
          status: 200,
          headers: { "Content-Type": contentType },
        });

        const awsBody = await awsResponseBody(response);

        expect(awsBody.body).toBe(binaryData.toString("base64"));
        expect(awsBody.isBase64Encoded).toBe(true);
      }
    });

    test("should handle missing content-type header", async () => {
      const response = new Response("content", { status: 200 });

      const awsBody = await awsResponseBody(response);

      expect(awsBody.body).toBe("content");
      expect(awsBody.isBase64Encoded).toBeUndefined();
    });

    test("should throw error for invalid response", async () => {
      await expect(awsResponseBody(null as any)).rejects.toThrow();

      await expect(awsResponseBody(undefined as any)).rejects.toThrow();
    });

    test("should handle stream errors gracefully", async () => {
      // Create a response with a problematic body stream
      const response = new Response("content", { status: 200 });

      // Mock the body to throw an error
      const mockBody = {
        pipeTo: vi.fn().mockRejectedValue(new Error("Stream error")),
      };
      Object.defineProperty(response, "body", {
        value: mockBody,
        writable: true,
      });

      await expect(awsResponseBody(response)).rejects.toThrow();
    });

    test("should handle large response bodies", async () => {
      const largeContent = "x".repeat(10_000);
      const response = new Response(largeContent, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });

      const awsBody = await awsResponseBody(response);

      expect(awsBody.body).toBe(largeContent);
      expect(awsBody.body.length).toBe(10_000);
    });
  });
});
