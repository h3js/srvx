import { afterEach, describe, expect, test, vi } from "vitest";
import {
  awsRequest,
  awsResponseBody,
  awsResponseHeaders,
  awsResultToResponse,
  awsStreamResponse,
  createMockContext,
  type AWSLambdaResponseStream,
} from "../src/adapters/_aws/utils.ts";
import {
  handleLambdaEvent,
  handleLambdaEventWithStream,
  invokeLambdaHandler,
  toLambdaHandler,
  toLambdaStreamHandler,
  type AWSLambdaHandler,
} from "../src/adapters/aws-lambda.ts";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  APIGatewayProxyResult,
} from "aws-lambda";

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

      const request = awsRequest(v1Event, createMockContext());

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

      const request = awsRequest(v2Event, createMockContext());

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

      const request = awsRequest(v1Event, createMockContext());

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

      const request = awsRequest(v1Event, createMockContext());

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

      const request = awsRequest(v1Event, createMockContext());

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

      const request = awsRequest(v1Event, createMockContext());

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

      const request = awsRequest(v1Event, createMockContext());

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

      const request = awsRequest(v1Event, createMockContext());

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

      // Forwarded protocol is only honored when the proxy is trusted.
      const request = awsRequest(v1Event, createMockContext(), true);

      expect(request.url).toMatch(/^http:\/\//);
    });

    test("should ignore X-Forwarded-Proto when proxy is not trusted (default)", () => {
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

      const request = awsRequest(v1Event, createMockContext());

      expect(request.url).toMatch(/^https:\/\//);
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

      const request = awsRequest(v1Event, createMockContext());

      expect(request.url).toMatch(/^https:\/\//);
    });

    test("should honor X-Forwarded-Host when proxy is trusted", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/users",
        headers: {
          host: "real.example.com",
          "x-forwarded-host": "forwarded.example.com",
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

      const request = awsRequest(v1Event, createMockContext(), true);

      expect(new URL(request.url).host).toBe("forwarded.example.com");
    });

    test("should ignore X-Forwarded-Host when proxy is not trusted (default)", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/users",
        headers: {
          host: "real.example.com",
          "x-forwarded-host": "forwarded.example.com",
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

      const request = awsRequest(v1Event, createMockContext());

      expect(new URL(request.url).host).toBe("real.example.com");
    });

    test("should honor X-Forwarded-For for request.ip when proxy is trusted", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/users",
        headers: {
          host: "api.example.com",
          "x-forwarded-for": "1.2.3.4, 10.0.0.1",
        },
        body: null,
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: { identity: { sourceIp: "10.0.0.1" } } as any,
        resource: "",
        queryStringParameters: null,
      };

      const request = awsRequest(v1Event, createMockContext(), true);

      expect(request.ip).toBe("1.2.3.4");
    });

    test("should ignore X-Forwarded-For for request.ip when not trusted (default)", () => {
      const v1Event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/users",
        headers: {
          host: "api.example.com",
          "x-forwarded-for": "1.2.3.4",
        },
        body: null,
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: { identity: { sourceIp: "10.0.0.1" } } as any,
        resource: "",
        queryStringParameters: null,
      };

      const request = awsRequest(v1Event, createMockContext());

      expect(request.ip).toBe("10.0.0.1");
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

      const request = awsRequest(v1Event, createMockContext());

      expect(request.url).toContain("/api/users/123");
    });
  });

  describe("awsResponseHeaders", () => {
    test("should convert Response headers to AWS format", () => {
      const headers = new Headers({
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
      // Use a real `Headers`: `set-cookie` therefore participates in header
      // iteration, which is exactly the case the old `MockHeaders` masked.
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("set-cookie", "sessionId=abc123; HttpOnly; Secure");
      headers.append("set-cookie", "theme=dark; Path=/");

      const response = new Response('{"message": "success"}', {
        status: 200,
        headers,
      });

      // v1 (default: no event) -> cookies delivered via multiValueHeaders.
      const awsResponse = awsResponseHeaders(response);

      expect(awsResponse.cookies).toEqual([
        "sessionId=abc123; HttpOnly; Secure",
        "theme=dark; Path=/",
      ]);
      expect(awsResponse.multiValueHeaders).toEqual({
        "set-cookie": ["sessionId=abc123; HttpOnly; Secure", "theme=dark; Path=/"],
      });
      // Regression (F19): set-cookie must NOT also appear in `headers`, or API
      // Gateway would merge both and send the last cookie twice.
      expect(awsResponse.headers["set-cookie"]).toBeUndefined();
    });

    test("should not duplicate set-cookie in headers for v2 events (F19)", () => {
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");

      const response = new Response("ok", { status: 200, headers });

      const v2Event: APIGatewayProxyEventV2 = {
        version: "2.0",
        routeKey: "GET /",
        rawPath: "/",
        rawQueryString: "",
        headers: { host: "example.com" },
        isBase64Encoded: false,
        requestContext: { http: { method: "GET", path: "/" } } as any,
      };

      const awsResponse = awsResponseHeaders(response, v2Event);

      expect(awsResponse.cookies).toEqual(["a=1", "b=2"]);
      expect(awsResponse.multiValueHeaders).toBeUndefined();
      expect(awsResponse.headers["set-cookie"]).toBeUndefined();
    });

    test("should handle array headers by joining with commas", () => {
      const headers = new Headers();
      headers.set("Accept", "application/json");
      headers.append("Accept", "text/html");
      headers.append("Accept", "text/plain");

      const response = new Response("content", {
        status: 200,
        headers,
      });

      const awsResponse = awsResponseHeaders(response);

      expect(awsResponse.headers.accept).toBe("application/json, text/html, text/plain");
    });

    test("should handle null/undefined header values", () => {
      const headers = new Headers({
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

  describe("handleLambdaEvent", () => {
    test("should convert AWS event to Response via fetch handler", async () => {
      const fetchHandler = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/test",
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

      const result = (await handleLambdaEvent(
        fetchHandler,
        event,
        createMockContext(),
      )) as APIGatewayProxyResult;

      expect(fetchHandler).toHaveBeenCalledTimes(1);
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe(JSON.stringify({ message: "success" }));
      expect(result.headers?.["content-type"]).toBe("application/json");
    });

    test("should handle POST request with body", async () => {
      const fetchHandler = vi.fn().mockImplementation(async (req: Request) => {
        const body = await req.json();
        return new Response(JSON.stringify({ received: body }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      });

      const event: APIGatewayProxyEvent = {
        httpMethod: "POST",
        path: "/api/users",
        headers: { host: "api.example.com", "content-type": "application/json" },
        body: JSON.stringify({ name: "John" }),
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        queryStringParameters: null,
      };

      const result = (await handleLambdaEvent(
        fetchHandler,
        event,
        createMockContext(),
      )) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(201);
      expect(JSON.parse(result.body)).toEqual({ received: { name: "John" } });
    });

    test("should handle error responses", async () => {
      const fetchHandler = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));

      const event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/missing",
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

      const result = (await handleLambdaEvent(
        fetchHandler,
        event,
        createMockContext(),
      )) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(404);
      expect(result.body).toBe("Not Found");
    });

    test("should handle binary response", async () => {
      const binaryData = Buffer.from("binary content");
      const fetchHandler = vi.fn().mockResolvedValue(
        new Response(binaryData, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      );

      const event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/binary",
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

      const result = (await handleLambdaEvent(
        fetchHandler,
        event,
        createMockContext(),
      )) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(200);
      expect(result.isBase64Encoded).toBe(true);
      expect(result.body).toBe(binaryData.toString("base64"));
    });

    test("should handle v2 event format", async () => {
      const fetchHandler = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));

      const v2Event: APIGatewayProxyEventV2 = {
        version: "2.0",
        routeKey: "GET /api/test",
        rawPath: "/api/test",
        rawQueryString: "",
        headers: { host: "api.example.com" },
        body: undefined,
        isBase64Encoded: false,
        requestContext: {
          http: { method: "GET", path: "/api/test" },
          domainName: "api.example.com",
        } as any,
      };

      const result = (await handleLambdaEvent(
        fetchHandler,
        v2Event,
        createMockContext(),
      )) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(200);
      const request = fetchHandler.mock.calls[0][0] as Request;
      expect(request.method).toBe("GET");
    });
  });

  describe("invokeLambdaHandler", () => {
    test("should convert Request to AWS event and invoke handler", async () => {
      const handler: AWSLambdaHandler = vi.fn().mockResolvedValue({
        statusCode: 200,
        body: JSON.stringify({ message: "success" }),
        headers: { "Content-Type": "application/json" },
      });

      const request = new Request("https://api.example.com/api/test", {
        method: "GET",
      });

      const response = await invokeLambdaHandler(handler, request);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ message: "success" });
    });

    test("should handle POST request with body", async () => {
      const handler: AWSLambdaHandler = vi.fn().mockImplementation(async (event) => {
        const body = JSON.parse(event.body || "{}");
        return {
          statusCode: 201,
          body: JSON.stringify({ received: body }),
          headers: { "Content-Type": "application/json" },
        };
      });

      const request = new Request("https://api.example.com/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "John" }),
      });

      const response = await invokeLambdaHandler(handler, request);

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ received: { name: "John" } });
    });

    test("should pass query parameters", async () => {
      const handler: AWSLambdaHandler = vi.fn().mockImplementation(async (event) => {
        return {
          statusCode: 200,
          body: JSON.stringify({
            page: event.queryStringParameters?.page,
            limit: event.queryStringParameters?.limit,
          }),
          headers: { "Content-Type": "application/json" },
        };
      });

      const request = new Request("https://api.example.com/api/items?page=2&limit=10");

      const response = await invokeLambdaHandler(handler, request);

      expect(await response.json()).toEqual({ page: "2", limit: "10" });
    });

    test("should handle cookies in request", async () => {
      const handler: AWSLambdaHandler = vi.fn().mockImplementation(async (event) => {
        return {
          statusCode: 200,
          body: JSON.stringify({ cookies: event.cookies }),
          headers: { "Content-Type": "application/json" },
        };
      });

      const request = new Request("https://api.example.com/api/test", {
        headers: { Cookie: "sessionId=abc123" },
      });

      const response = await invokeLambdaHandler(handler, request);

      const body = await response.json();
      expect(body.cookies).toContain("sessionId=abc123");
    });

    test("should handle handler returning cookies", async () => {
      const handler: AWSLambdaHandler = vi.fn().mockResolvedValue({
        statusCode: 200,
        body: "OK",
        cookies: ["sessionId=xyz789; HttpOnly", "theme=dark"],
      });

      const request = new Request("https://api.example.com/api/login");

      const response = await invokeLambdaHandler(handler, request);

      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toContain("sessionId=xyz789; HttpOnly");
      expect(response.headers.getSetCookie()).toContain("theme=dark");
    });

    test("should handle binary response from handler", async () => {
      const binaryData = Buffer.from("binary content");
      const handler: AWSLambdaHandler = vi.fn().mockResolvedValue({
        statusCode: 200,
        body: binaryData.toString("base64"),
        isBase64Encoded: true,
        headers: { "Content-Type": "application/octet-stream" },
      });

      const request = new Request("https://api.example.com/api/binary");

      const response = await invokeLambdaHandler(handler, request);

      expect(response.status).toBe(200);
      const arrayBuffer = await response.arrayBuffer();
      expect(Buffer.from(arrayBuffer).toString()).toBe("binary content");
    });

    test("should handle error status codes", async () => {
      const handler: AWSLambdaHandler = vi.fn().mockResolvedValue({
        statusCode: 500,
        body: "Internal Server Error",
      });

      const request = new Request("https://api.example.com/api/error");

      const response = await invokeLambdaHandler(handler, request);

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
    });

    test("should handle multiValueHeaders from handler (v1)", async () => {
      const handler: AWSLambdaHandler = vi.fn().mockResolvedValue({
        statusCode: 200,
        body: "OK",
        multiValueHeaders: {
          "Set-Cookie": ["a=1", "b=2"],
          "X-Custom": ["value1", "value2"],
        },
      });

      const request = new Request("https://api.example.com/api/test");

      const response = await invokeLambdaHandler(handler, request);

      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toContain("a=1");
      expect(response.headers.getSetCookie()).toContain("b=2");
    });

    test("should handle string response (v2 simple format)", async () => {
      const handler: AWSLambdaHandler = vi.fn().mockResolvedValue("Hello World" as any);

      const request = new Request("https://api.example.com/api/simple");

      const response = await invokeLambdaHandler(handler, request);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("Hello World");
    });
  });

  describe("awsStreamResponse", () => {
    function createMockResponseStream() {
      const chunks: unknown[] = [];
      let metadata: unknown;
      let endCalled = false;
      let drainCallback: (() => void) | null = null;

      const mockWriter = {
        write: vi.fn((chunk: unknown) => {
          chunks.push(chunk);
          return true; // No backpressure by default
        }),
        end: vi.fn(() => {
          endCalled = true;
        }),
        once: vi.fn((event: string, callback: () => void) => {
          if (event === "drain") {
            drainCallback = callback;
          }
        }),
      };

      const mockStream = {} as AWSLambdaResponseStream;

      // Mock the awslambda global
      (globalThis as any).awslambda = {
        HttpResponseStream: {
          from: vi.fn((stream: unknown, meta: unknown) => {
            metadata = meta;
            return mockWriter;
          }),
        },
      };

      return {
        mockStream,
        mockWriter,
        getChunks: () => chunks,
        getMetadata: () => metadata,
        isEndCalled: () => endCalled,
        triggerDrain: () => drainCallback?.(),
      };
    }

    afterEach(() => {
      delete (globalThis as any).awslambda;
    });

    test("should stream response body to writer", async () => {
      const { mockStream, mockWriter, getChunks, getMetadata, isEndCalled } =
        createMockResponseStream();

      const response = new Response("Hello, Stream!", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });

      await awsStreamResponse(response, mockStream);

      expect(getMetadata()).toMatchObject({
        statusCode: 200,
        headers: expect.objectContaining({
          "content-type": "text/plain",
          "transfer-encoding": "chunked",
        }),
      });
      expect(getChunks().length).toBeGreaterThan(0);
      expect(isEndCalled()).toBe(true);
      expect(mockWriter.end).toHaveBeenCalled();
    });

    test("should handle empty response body", async () => {
      const { mockStream, mockWriter, getChunks, isEndCalled } = createMockResponseStream();

      const response = new Response(null, { status: 204 });

      await awsStreamResponse(response, mockStream);

      expect(getChunks()).toEqual([""]);
      expect(isEndCalled()).toBe(true);
      expect(mockWriter.write).toHaveBeenCalledWith("");
      expect(mockWriter.end).toHaveBeenCalled();
    });

    test("should set transfer-encoding to chunked by default", async () => {
      const { mockStream, getMetadata } = createMockResponseStream();

      const response = new Response("content", { status: 200 });

      await awsStreamResponse(response, mockStream);

      expect((getMetadata() as any).headers["transfer-encoding"]).toBe("chunked");
    });

    test("should preserve existing transfer-encoding header", async () => {
      const { mockStream, getMetadata } = createMockResponseStream();

      const response = new Response("content", {
        status: 200,
        headers: { "Transfer-Encoding": "gzip" },
      });

      await awsStreamResponse(response, mockStream);

      expect((getMetadata() as any).headers["transfer-encoding"]).toBe("gzip");
    });

    test("should call writer.end even when streaming fails", async () => {
      const { mockStream, mockWriter } = createMockResponseStream();

      // Create a response with a body that will error during streaming
      const errorStream = new ReadableStream({
        start(controller) {
          controller.error(new Error("Stream error"));
        },
      });

      const response = new Response(errorStream, { status: 200 });

      await expect(awsStreamResponse(response, mockStream)).rejects.toThrow("Stream error");
      expect(mockWriter.end).toHaveBeenCalled();
    });

    test("should handle backpressure from writer", async () => {
      const { mockStream, mockWriter, triggerDrain } = createMockResponseStream();

      let writeCount = 0;
      mockWriter.write.mockImplementation(() => {
        writeCount++;
        // Simulate backpressure on first write
        if (writeCount === 1) {
          // Trigger drain after a microtask
          Promise.resolve().then(() => triggerDrain());
          return false;
        }
        return true;
      });

      const response = new Response("AB", { status: 200 });

      await awsStreamResponse(response, mockStream);

      expect(mockWriter.once).toHaveBeenCalledWith("drain", expect.any(Function));
      expect(mockWriter.end).toHaveBeenCalled();
    });

    test("should pass event to awsResponseHeaders for v2 format", async () => {
      const { mockStream, getMetadata } = createMockResponseStream();

      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("set-cookie", "session=abc");

      const response = new Response("{}", { status: 200, headers });

      const v2Event: APIGatewayProxyEventV2 = {
        version: "2.0",
        routeKey: "GET /test",
        rawPath: "/test",
        rawQueryString: "",
        headers: { host: "example.com" },
        isBase64Encoded: false,
        requestContext: { http: { method: "GET", path: "/test" } } as any,
      };

      await awsStreamResponse(response, mockStream, v2Event);

      const metadata = getMetadata() as any;
      expect(metadata.cookies).toEqual(["session=abc"]);
      // Regression (F19): the streaming prelude must not also carry set-cookie
      // in `headers`.
      expect(metadata.headers["set-cookie"]).toBeUndefined();
    });
  });

  describe("handleLambdaEventWithStream", () => {
    function createMockResponseStream() {
      const chunks: unknown[] = [];
      let metadata: unknown;

      const mockWriter = {
        write: vi.fn((chunk: unknown) => {
          chunks.push(chunk);
          return true;
        }),
        end: vi.fn(),
        once: vi.fn(),
      };

      const mockStream = {} as AWSLambdaResponseStream;

      (globalThis as any).awslambda = {
        HttpResponseStream: {
          from: vi.fn((stream: unknown, meta: unknown) => {
            metadata = meta;
            return mockWriter;
          }),
        },
      };

      return {
        mockStream,
        mockWriter,
        getChunks: () => chunks,
        getMetadata: () => metadata,
      };
    }

    afterEach(() => {
      delete (globalThis as any).awslambda;
    });

    test("should convert event to request and stream response", async () => {
      const { mockStream, mockWriter, getMetadata } = createMockResponseStream();

      const fetchHandler = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "streamed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/stream",
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

      await handleLambdaEventWithStream(fetchHandler, event, mockStream, createMockContext());

      expect(fetchHandler).toHaveBeenCalledTimes(1);
      const request = fetchHandler.mock.calls[0][0] as Request;
      expect(request.method).toBe("GET");
      expect(request.url).toContain("/api/stream");

      expect((getMetadata() as any).statusCode).toBe(200);
      expect(mockWriter.end).toHaveBeenCalled();
    });

    test("should handle POST request with body", async () => {
      const { mockStream } = createMockResponseStream();

      const fetchHandler = vi.fn().mockImplementation(async (req: Request) => {
        const body = await req.json();
        return new Response(JSON.stringify({ received: body }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      });

      const event: APIGatewayProxyEvent = {
        httpMethod: "POST",
        path: "/api/data",
        headers: { host: "api.example.com", "content-type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        queryStringParameters: null,
      };

      await handleLambdaEventWithStream(fetchHandler, event, mockStream, createMockContext());

      expect(fetchHandler).toHaveBeenCalledTimes(1);
    });

    test("should handle v2 event format", async () => {
      const { mockStream, getMetadata } = createMockResponseStream();

      const fetchHandler = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));

      const v2Event: APIGatewayProxyEventV2 = {
        version: "2.0",
        routeKey: "GET /api/v2",
        rawPath: "/api/v2",
        rawQueryString: "foo=bar",
        headers: { host: "api.example.com" },
        isBase64Encoded: false,
        requestContext: {
          http: { method: "GET", path: "/api/v2" },
          domainName: "api.example.com",
        } as any,
      };

      await handleLambdaEventWithStream(fetchHandler, v2Event, mockStream, createMockContext());

      const request = fetchHandler.mock.calls[0][0] as Request;
      expect(request.method).toBe("GET");
      expect(request.url).toContain("/api/v2");
      expect(request.url).toContain("foo=bar");
      expect((getMetadata() as any).statusCode).toBe(200);
    });

    test("should close the stream for redirects without a response body", async () => {
      const { mockStream, mockWriter, getChunks, getMetadata } = createMockResponseStream();

      const fetchHandler = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: {
            location: "/",
          },
        }),
      );

      const event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/redirect",
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

      await handleLambdaEventWithStream(fetchHandler, event, mockStream, createMockContext());

      expect((getMetadata() as any).statusCode).toBe(302);
      expect((getMetadata() as any).headers.location).toBe("/");
      expect(getChunks()).toEqual([""]);
      expect(mockWriter.write).toHaveBeenCalledWith("");
      expect(mockWriter.end).toHaveBeenCalled();
    });

    test("should handle fetch handler errors", async () => {
      const { mockStream, mockWriter } = createMockResponseStream();

      const fetchHandler = vi.fn().mockRejectedValue(new Error("Handler error"));

      const event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/api/error",
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

      await expect(
        handleLambdaEventWithStream(fetchHandler, event, mockStream, createMockContext()),
      ).rejects.toThrow("Handler error");

      // writer.end should NOT be called since error happened before streaming
      expect(mockWriter.end).not.toHaveBeenCalled();
    });

    // API Gateway REST APIs (v1) now support response streaming via
    // `responseTransferMode: STREAM` + the `InvokeWithResponseStream` API,
    // using the same `APIGatewayProxyEvent` input shape as buffered proxy
    // integrations. See: https://github.com/h3js/srvx/issues/184 and
    // https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html
    describe("API Gateway REST API (v1) streaming", () => {
      test("delivers chunks to the writer progressively instead of buffering the full body", async () => {
        const { mockStream, mockWriter, getChunks } = createMockResponseStream();

        const fetchHandler = vi.fn().mockImplementation(async () => {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode("chunk-1"));
              await Promise.resolve();
              controller.enqueue(encoder.encode("chunk-2"));
              await Promise.resolve();
              controller.enqueue(encoder.encode("chunk-3"));
              controller.close();
            },
          });
          return new Response(stream, { headers: { "content-type": "text/plain" } });
        });

        const v1Event: APIGatewayProxyEvent = {
          httpMethod: "GET",
          path: "/stream",
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

        await handleLambdaEventWithStream(fetchHandler, v1Event, mockStream, createMockContext());

        // Each chunk must reach the writer as a separate write, otherwise
        // API Gateway can't start forwarding bytes before the body is complete.
        const decoder = new TextDecoder();
        expect(getChunks().map((chunk) => decoder.decode(chunk as Uint8Array))).toEqual([
          "chunk-1",
          "chunk-2",
          "chunk-3",
        ]);
        expect(mockWriter.end).toHaveBeenCalled();
      });

      test("emits a metadata prelude matching the API Gateway stream-response format", async () => {
        const { mockStream, getMetadata } = createMockResponseStream();

        const fetchHandler = vi.fn().mockResolvedValue(
          new Response("ok", {
            status: 201,
            headers: { "content-type": "text/plain" },
          }),
        );

        const v1Event: APIGatewayProxyEvent = {
          httpMethod: "GET",
          path: "/stream",
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

        await handleLambdaEventWithStream(fetchHandler, v1Event, mockStream, createMockContext());

        const metadata = getMetadata() as any;

        // AWS only accepts `headers`, `multiValueHeaders`, `cookies` and
        // `statusCode` in the JSON prelude - no v2-only fields should leak in.
        expect(Object.keys(metadata).sort()).toEqual(["headers", "statusCode"]);
        expect(metadata.statusCode).toBe(201);

        // API Gateway requires either `Transfer-Encoding: chunked` or a
        // `Content-Length` header on the prelude, or it rejects the stream.
        expect(
          metadata.headers["transfer-encoding"] || metadata.headers["content-length"],
        ).toBeTruthy();
      });
    });
  });

  describe("stabilization regressions", () => {
    function v1Event(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
      return {
        httpMethod: "GET",
        path: "/",
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
        ...overrides,
      };
    }

    test("F20: merges v1 multiValueHeaders without duplicating single headers", () => {
      const request = awsRequest(
        v1Event({
          headers: { host: "api.example.com", "x-test": "b" },
          multiValueHeaders: { "X-Test": ["a", "b"], host: ["api.example.com"] },
        }),
        createMockContext(),
      );

      // Both values are present (repeated header preserved) and the single-map
      // entry is not appended a second time.
      expect(request.headers.get("x-test")).toBe("a, b");
      expect(request.headers.get("host")).toBe("api.example.com");
    });

    test("F21: compressed body is base64-encoded even for a text content-type", async () => {
      const gzipped = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
      const response = new Response(gzipped, {
        status: 200,
        headers: { "content-type": "text/html", "content-encoding": "gzip" },
      });

      const awsBody = await awsResponseBody(response);

      expect(awsBody.isBase64Encoded).toBe(true);
      expect(awsBody.body).toBe(gzipped.toString("base64"));
    });

    test("F21: identity content-encoding still uses utf8 for text", async () => {
      const response = new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain", "content-encoding": "identity" },
      });

      const awsBody = await awsResponseBody(response);

      expect(awsBody.isBase64Encoded).toBeUndefined();
      expect(awsBody.body).toBe("hello");
    });

    test("F22: 204 handler round-trips through invokeLambdaHandler without throwing", async () => {
      const handler = toLambdaHandler({
        fetch: () => new Response(null, { status: 204 }),
      });

      const response = await invokeLambdaHandler(handler, new Request("https://x.example/"));

      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    });

    test("F22: awsResultToResponse passes null body for 304", () => {
      const response = awsResultToResponse({ statusCode: 304, body: "" } as any);
      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
    });

    test("F8: cookie round-trips once (no doubling)", async () => {
      let seenCookie: string | null = null;
      const handler = toLambdaHandler({
        fetch: (req) => {
          seenCookie = req.headers.get("cookie");
          return new Response("ok");
        },
      });

      await invokeLambdaHandler(
        handler,
        new Request("https://x.example/", { headers: { cookie: "a=1" } }),
      );

      expect(seenCookie).toBe("a=1");
    });

    test("F24: request.waitUntil is awaited before the invocation returns", async () => {
      let done = false;
      const fetchHandler = async (req: Request & { waitUntil?: (p: Promise<unknown>) => void }) => {
        req.waitUntil?.(
          new Promise<void>((resolve) =>
            setTimeout(() => {
              done = true;
              resolve();
            }, 10),
          ),
        );
        return new Response("ok");
      };

      await handleLambdaEvent(fetchHandler as any, v1Event(), createMockContext());

      expect(done).toBe(true);
    });

    test("F15: null headers throw a clear error", () => {
      expect(() => awsRequest(v1Event({ headers: null as any }), createMockContext())).toThrow(
        /headers/,
      );
    });

    test("F15: GET with a body is treated as null-body instead of throwing", () => {
      const request = awsRequest(
        v1Event({ httpMethod: "GET", body: "should-be-dropped", isBase64Encoded: false }),
        createMockContext(),
      );
      expect(request.body).toBeNull();
    });

    describe("F23: streaming path applies middleware/error", () => {
      function createMockResponseStream() {
        let metadata: unknown;
        const mockWriter = {
          write: vi.fn(() => true),
          end: vi.fn(),
          once: vi.fn(),
        };
        (globalThis as any).awslambda = {
          HttpResponseStream: {
            from: vi.fn((_stream: unknown, meta: unknown) => {
              metadata = meta;
              return mockWriter;
            }),
          },
        };
        return { mockStream: {} as AWSLambdaResponseStream, getMetadata: () => metadata };
      }

      afterEach(() => {
        delete (globalThis as any).awslambda;
      });

      test("toLambdaStreamHandler runs middleware", async () => {
        const { mockStream, getMetadata } = createMockResponseStream();

        const handler = toLambdaStreamHandler({
          middleware: [() => new Response("from-middleware", { status: 299 })],
          fetch: () => new Response("from-fetch", { status: 200 }),
        });

        await handler(v1Event(), mockStream, createMockContext());

        // The middleware short-circuited, proving it was wired into the
        // streaming path (previously bypassed entirely).
        expect((getMetadata() as any).statusCode).toBe(299);
      });

      test("toLambdaStreamHandler applies the error option on a thrown handler", async () => {
        const { mockStream, getMetadata } = createMockResponseStream();

        const handler = toLambdaStreamHandler({
          error: () => new Response("handled", { status: 503 }),
          fetch: () => {
            throw new Error("boom");
          },
        });

        await handler(v1Event(), mockStream, createMockContext());

        expect((getMetadata() as any).statusCode).toBe(503);
      });
    });
  });
});
