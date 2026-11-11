import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll } from "vitest";
import { execa, type ResultPromise as ExecaRes } from "execa";
import { getRandomPort } from "get-port-please";
import { addTests } from "./_tests.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));

function canConnect(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "localhost", signal });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(100);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Wait until `child` accepts TCP connections on `port`.
 *
 * Probes with a real connection (a bind-based "port in use" check can report a
 * free port while the server already listens, e.g. macOS + Node 24) and races
 * against the child exiting, so early failures surface with their exit status
 * and output instead of a generic timeout.
 */
export async function waitForServer(
  port: number,
  child: ExecaRes,
  opts: { timeout?: number } = {},
): Promise<void> {
  const controller = new AbortController();
  // Children may be spawned with or without `reject: false`; normalize both.
  const exited = child
    .then(
      (result) => result,
      (error) => error,
    )
    .then(({ exitCode, signal }) => {
      throw new Error(
        `Process exited with ${signal ? `signal ${signal}` : `code ${exitCode}`} before listening on port ${port}`,
      );
    });
  const listening = async () => {
    const deadline = Date.now() + (opts.timeout ?? 5000);
    while (Date.now() < deadline) {
      if (await canConnect(port, controller.signal)) {
        return;
      }
      await delay(50, undefined, { signal: controller.signal });
    }
    throw new Error(`Timeout waiting for server on port ${port}`);
  };
  try {
    await Promise.race([listening(), exited]);
  } catch (error) {
    controller.abort();
    child.kill("SIGTERM");
    const { stderr, stdout } = await child.catch((error_) => error_);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${stderr ?? ""}\n${stdout ?? ""}`, { cause: error });
  } finally {
    controller.abort();
  }
}

// Output that tests deliberately provoke and runtimes print to stderr. These
// are expected and only add noise to the vitest output, so they are filtered
// out (unless TEST_DEBUG is set). See `test/_utils.ts` stderr forwarding.
const IGNORED_STDERR: RegExp[] = [
  // Intentional error thrown by the `/response/stream-error` fixture route.
  /stream error!/,
  // Deno legacy-behavior deprecation warning (Deno.serve request.signal abort).
  /Deno\.serve: request\.signal aborts on successful responses/,
];

export function testsExec(cmd: string, opts: { runtime: string; silent?: boolean }): void {
  let childProc: ExecaRes;
  let baseURL: string;

  beforeAll(async () => {
    const port = await getRandomPort("localhost");
    baseURL = `http://localhost:${port}/`;
    const [bin, ...args] = cmd.replace("./", testDir).split(" ");
    if (process.env.TEST_DEBUG) {
      console.log(`$ ${bin} ${args.join(" ")}`);
    }
    childProc = execa(bin, args, { env: { PORT: port.toString() } });
    childProc.catch((error) => {
      if (error.signal !== "SIGTERM") {
        console.error(error);
      }
    });
    if (process.env.TEST_DEBUG || !opts.silent) {
      childProc.stderr!.on("data", (chunk) => {
        const str = chunk.toString();
        // Filter known-benign output that tests intentionally trigger, so real
        // fixture errors stay visible. Bypassed when TEST_DEBUG is set.
        if (!process.env.TEST_DEBUG && IGNORED_STDERR.some((re) => re.test(str))) {
          return;
        }
        console.log(str);
      });
    }
    if (process.env.TEST_DEBUG) {
      childProc.stdout!.on("data", (chunk) => {
        console.log(chunk.toString());
      });
    }
    await waitForServer(port, childProc);
  });

  afterAll(async () => {
    await childProc.kill();
  });

  addTests({
    url: (path) => baseURL + path.slice(1),
    ...opts,
  });
}

export async function getTLSCert(): Promise<{
  ca: string;
  cert: string;
  key: string;
  clientCert: string;
  clientKey: string;
}> {
  const certDir = join(testDir, ".tmp/tls");
  const caFile = join(certDir, "ca.crt");
  const certFile = join(certDir, "server.crt");
  const keyFile = join(certDir, "server.key");
  const clientCertFile = join(certDir, "client.crt");
  const clientKeyFile = join(certDir, "client.key");

  if (
    existsSync(caFile) &&
    existsSync(certFile) &&
    existsSync(keyFile) &&
    existsSync(clientCertFile) &&
    existsSync(clientKeyFile)
  ) {
    return {
      ca: await readFile(caFile, "utf8"),
      cert: await readFile(certFile, "utf8"),
      key: await readFile(keyFile, "utf8"),
      clientCert: await readFile(clientCertFile, "utf8"),
      clientKey: await readFile(clientKeyFile, "utf8"),
    };
  }

  const { pki, md } = await import("node-forge");

  // Generate keys
  const caKeys = pki.rsa.generateKeyPair(2048);
  const serverKeys = pki.rsa.generateKeyPair(2048);
  const clientKeys = pki.rsa.generateKeyPair(2048);

  // Create CA cert
  const caCert = pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = "01";
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  caCert.setSubject([{ name: "commonName", value: "Test CA" }]);
  caCert.setIssuer(caCert.subject.attributes);
  caCert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, digitalSignature: true },
    { name: "subjectKeyIdentifier" },
  ]);
  caCert.sign(caKeys.privateKey, md.sha256.create());

  // Create server cert
  const serverCert = pki.createCertificate();
  serverCert.publicKey = serverKeys.publicKey;
  serverCert.serialNumber = "02";
  serverCert.validity.notBefore = new Date();
  serverCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  serverCert.setSubject([{ name: "commonName", value: "localhost" }]);
  serverCert.setIssuer(caCert.subject.attributes);
  serverCert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
        { type: 7, ip: "::1" },
      ],
    },
  ]);
  serverCert.sign(caKeys.privateKey, md.sha256.create());

  // Create client cert (for mutual TLS), signed by the same CA
  const clientCertObj = pki.createCertificate();
  clientCertObj.publicKey = clientKeys.publicKey;
  clientCertObj.serialNumber = "03";
  clientCertObj.validity.notBefore = new Date();
  clientCertObj.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  clientCertObj.setSubject([{ name: "commonName", value: "Test Client" }]);
  clientCertObj.setIssuer(caCert.subject.attributes);
  clientCertObj.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", clientAuth: true },
  ]);
  clientCertObj.sign(caKeys.privateKey, md.sha256.create());

  const ca = pki.certificateToPem(caCert);
  const key = pki.privateKeyToPem(serverKeys.privateKey);
  const cert = pki.certificateToPem(serverCert);
  const clientKey = pki.privateKeyToPem(clientKeys.privateKey);
  const clientCert = pki.certificateToPem(clientCertObj);

  await mkdir(certDir, { recursive: true });
  await writeFile(caFile, ca);
  await writeFile(certFile, cert);
  await writeFile(keyFile, key);
  await writeFile(clientCertFile, clientCert);
  await writeFile(clientKeyFile, clientKey);

  return { ca, cert, key, clientCert, clientKey };
}
