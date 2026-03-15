/// <reference types="deno" />
/// <reference types="serviceworker" />

declare module "cloudflare:workers" {
  export const env: {
    TEST: string;
  };
}
