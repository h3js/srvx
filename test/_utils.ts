import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll } from "vitest";
import { execa, type ResultPromise as ExecaRes } from "execa";
import { getRandomPort, waitForPort } from "get-port-please";
import { addTests } from "./_tests.ts";

const testDir = fileURLToPath(new URL(".", import.meta.url));

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
        console.log(chunk.toString());
      });
    }
    if (process.env.TEST_DEBUG) {
      childProc.stdout!.on("data", (chunk) => {
        console.log(chunk.toString());
      });
    }
    await waitForPort(port, { host: "localhost", delay: 50, retries: 100 });
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
}> {
  const certDir = join(testDir, ".tmp/tls");
  const caFile = join(certDir, "ca.crt");
  const certFile = join(certDir, "server.crt");
  const keyFile = join(certDir, "server.key");

  if (existsSync(caFile) && existsSync(certFile) && existsSync(keyFile)) {
    return {
      ca: await readFile(caFile, "utf8"),
      cert: await readFile(certFile, "utf8"),
      key: await readFile(keyFile, "utf8"),
    };
  }

  const { pki, md } = await import("node-forge");

  // Generate keys
  const caKeys = pki.rsa.generateKeyPair(2048);
  const serverKeys = pki.rsa.generateKeyPair(2048);

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

  const ca = pki.certificateToPem(caCert);
  const key = pki.privateKeyToPem(serverKeys.privateKey);
  const cert = pki.certificateToPem(serverCert);

  await mkdir(certDir, { recursive: true });
  await writeFile(caFile, ca);
  await writeFile(certFile, cert);
  await writeFile(keyFile, key);

  return { ca, cert, key };
}
