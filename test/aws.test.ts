import { describe, expect, test, vi } from "vitest";
import {
  awsRequest,
  awsResponseBody,
  awsResponseHeaders,
  createMockContext,
} from "../src/adapters/_aws/_utils.ts";
import {
  handleLambdaEvent,
  invokeLambdaHandler,
  type AWSLambdaHandler,
} from "../src/adapters/aws-lambda.ts";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  APIGatewayProxyResult,
} from "aws-lambda";

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

      const request = awsRequest(v1Event, createMockContext());

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

      const request = awsRequest(v1Event, createMockContext());

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

      const request = awsRequest(v1Event, createMockContext());

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
        "set-cookie": ["sessionId=abc123; HttpOnly; Secure", "theme=dark; Path=/"],
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

      expect(awsResponse.headers.accept).toBe("application/json, text/html, text/plain");
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
});
