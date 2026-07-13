# AWS Lambda example

Deploys an srvx app behind an API Gateway REST API (v1), using the [Serverless Framework](https://www.serverless.com/).

## Deploy

```sh
npx serverless deploy
```

This requires valid AWS credentials (`aws configure` or the usual `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars).

## Verifying REST API v1 response streaming

The `stream` function (`stream.ts`) is wired up in `serverless.yml` with `response.transferMode: STREAM`, so API Gateway invokes it via [`InvokeWithResponseStream`](https://docs.aws.amazon.com/lambda/latest/api/API_InvokeWithResponseStream.html) and forwards bytes to the client as soon as srvx writes them, instead of buffering the full response first.

> [!NOTE]
> `serverless offline` does **not** support Lambda response streaming ([serverless-offline#1681](https://github.com/dherault/serverless-offline/issues/1681)), so this can only be verified against a real deployment, not `npm run dev`.

After deploying, hit the `/stream` endpoint with `curl` (not a browser — some browsers still buffer chunked responses from API Gateway, see [serverless#13177](https://github.com/serverless/serverless/issues/13177)) and watch chunks arrive roughly every 500ms instead of all at once at the end:

```sh
curl -N --no-buffer https://<your-api-id>.execute-api.<region>.amazonaws.com/stream
```

Each printed line embeds its own server-side timestamp, so if streaming is actually working you'll see `curl` print lines one by one, ~500ms apart, rather than all five lines appearing together after ~2.5s.
