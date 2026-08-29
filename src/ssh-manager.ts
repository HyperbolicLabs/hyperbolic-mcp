import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ConnectConfig } from "ssh2";
import { Client } from "ssh2";

/** Result of a connection attempt. */
export type SSHConnectResult = {
  ok: boolean;
  message: string;
};

/**
 * Result of a remote command.
 *
 * The previous API returned a single string and callers decided whether the
 * command had failed by testing whether that string started with `"Error:"`.
 * That misreported both directions: a successful command whose own output began
 * with `Error:` (a grep over a log file, for example) was flagged as a failure,
 * and a command that exited non-zero while writing nothing to stderr was
 * reported as a success. The exit code is now returned explicitly.
 */
export type SSHExecuteResult = {
  ok: boolean;
  /** Remote exit status, or `null` if the channel closed without reporting one. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set only when the command could not be run at all (transport failure). */
  error?: string;
};

/**
 * Environment variable that disables host-key checking entirely. It exists for
 * throwaway lab hosts; setting it means an on-path attacker can impersonate the
 * server and capture anything typed into the session, including credentials.
 */
const ALLOW_UNKNOWN_HOST_KEY_ENV = "HYPERBOLIC_MCP_INSECURE_SKIP_HOST_KEY_CHECK";

/** Maximum bytes buffered per stream, to bound memory on chatty commands. */
const MAX_STREAM_BYTES = 1024 * 1024;

/** Where accepted host fingerprints are recorded (trust on first use). */
const KNOWN_HOSTS_DIR = path.join(os.homedir(), ".hyperbolic-mcp");
const KNOWN_HOSTS_FILE = path.join(KNOWN_HOSTS_DIR, "known-hosts.json");

/** `~` expansion that works when `HOME` is unset and on Windows, where it is. */
function expandHome(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/** OpenSSH-style `SHA256:<base64>` fingerprint of a raw host key. */
function fingerprintHostKey(key: Buffer): string {
  return `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function readKnownHosts(): Record<string, string> {
  try {
    const raw = fs.readFileSync(KNOWN_HOSTS_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // A missing or corrupt store is treated as empty: the next successful
    // connection re-records the fingerprint. It is never treated as "trusted".
  }
  return {};
}

function writeKnownHosts(entries: Record<string, string>): void {
  try {
    fs.mkdirSync(KNOWN_HOSTS_DIR, { recursive: true, mode: 0o700 });
    // The file records which hosts are trusted, so it must not be writable by
    // other local users; `mode` on `writeFileSync` only applies at creation.
    fs.writeFileSync(KNOWN_HOSTS_FILE, `${JSON.stringify(entries, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    console.error(
      `Warning: could not persist host fingerprint to ${KNOWN_HOSTS_FILE}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Singleton class to manage SSH connections
 */
class SSHManager {
  private static instance: SSHManager;
  private sshClient: Client | null = null;
  private connected = false;
  private host: string | null = null;
  private username: string | null = null;

  /**
   * Private constructor for singleton pattern
   */
  private constructor() {}

  /**
   * Get the SSHManager instance
   */
  public static getInstance(): SSHManager {
    if (!SSHManager.instance) {
      SSHManager.instance = new SSHManager();
    }
    return SSHManager.instance;
  }

  /**
   * Check if there's an active SSH connection
   */
  public isConnected(): boolean {
    return this.connected && this.sshClient !== null;
  }

  /**
   * Verifies the server's host key before authentication proceeds.
   *
   * The connection previously supplied no `hostVerifier`, so ssh2 accepted any
   * host key presented. Anything on the network path could answer for the
   * instance and collect the password or agent-forwarded credentials — the SSH
   * equivalent of skipping TLS certificate validation.
   *
   * Verification is trust-on-first-use: the first fingerprint seen for a
   * `host:port` is recorded, and a later change is rejected. A caller that
   * already knows the fingerprint can pin it via `expectedFingerprint`, which is
   * checked instead of the store.
   */
  private verifyHostKey(
    hostKeyId: string,
    key: Buffer,
    expectedFingerprint?: string
  ): { accepted: boolean; reason?: string } {
    const fingerprint = fingerprintHostKey(key);

    if (expectedFingerprint) {
      const normalized = expectedFingerprint.trim().replace(/=+$/, "");
      if (normalized !== fingerprint) {
        return {
          accepted: false,
          reason: `host key fingerprint mismatch: expected ${normalized}, server presented ${fingerprint}`,
        };
      }
      return { accepted: true };
    }

    if (process.env[ALLOW_UNKNOWN_HOST_KEY_ENV] === "true") {
      console.error(
        `Warning: ${ALLOW_UNKNOWN_HOST_KEY_ENV}=true — accepting ${hostKeyId} host key ${fingerprint} without verification.`
      );
      return { accepted: true };
    }

    const knownHosts = readKnownHosts();
    const stored = knownHosts[hostKeyId];

    if (!stored) {
      knownHosts[hostKeyId] = fingerprint;
      writeKnownHosts(knownHosts);
      console.error(`Recorded new host key for ${hostKeyId}: ${fingerprint}`);
      return { accepted: true };
    }

    if (stored !== fingerprint) {
      return {
        accepted: false,
        reason:
          `host key for ${hostKeyId} has changed (known ${stored}, presented ${fingerprint}). ` +
          `If the instance was legitimately rebuilt, remove that entry from ${KNOWN_HOSTS_FILE} and reconnect.`,
      };
    }

    return { accepted: true };
  }

  /**
   * Establish SSH connection
   * @param host Hostname or IP address of the remote server
   * @param username SSH username for authentication
   * @param password Optional SSH password for authentication
   * @param privateKeyPath Optional path to private key file
   * @param port SSH port number (default: 22)
   * @param timeout Connection timeout in milliseconds (default: 10000)
   * @param expectedFingerprint Optional pinned `SHA256:...` host fingerprint
   */
  public async connect(
    host: string,
    username: string,
    password?: string,
    privateKeyPath?: string,
    port: number = 22,
    timeout: number = 10000,
    expectedFingerprint?: string
  ): Promise<SSHConnectResult> {
    try {
      // Close existing connection if any
      await this.disconnect();

      // Initialize new client
      this.sshClient = new Client();

      // `process.env.HOME` is not set on Windows (it uses USERPROFILE), so the
      // old `replace(/^~/, process.env.HOME || "")` produced the relative path
      // "/.ssh/id_rsa" there and the key was never found. `os.homedir()` is
      // correct on every platform.
      const defaultKeyPath = process.env.SSH_PRIVATE_KEY_PATH || "~/.ssh/id_rsa";

      // Typed as ConnectConfig rather than `any`, so a misspelled option or a
      // wrong value type is a compile error instead of an ignored field.
      const connectOptions: ConnectConfig = {
        host,
        port,
        username,
        readyTimeout: timeout,
      };

      if (password) {
        connectOptions.password = password;
      } else {
        const expandedKeyPath = expandHome(privateKeyPath || defaultKeyPath);

        if (!fs.existsSync(expandedKeyPath)) {
          return {
            ok: false,
            message: `SSH Key Error: Key file not found at ${expandedKeyPath}`,
          };
        }

        try {
          connectOptions.privateKey = fs.readFileSync(expandedKeyPath);
        } catch (error) {
          return {
            ok: false,
            message: `SSH Key Error: Failed to read key file ${expandedKeyPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      }

      const hostKeyId = `${host}:${port}`;
      let hostKeyFailure: string | null = null;
      connectOptions.hostVerifier = ((key: Buffer, verify: (valid: boolean) => void) => {
        const outcome = this.verifyHostKey(hostKeyId, key, expectedFingerprint);
        if (!outcome.accepted) {
          hostKeyFailure = outcome.reason ?? "host key rejected";
          console.error(`SSH host key rejected for ${hostKeyId}: ${hostKeyFailure}`);
        }
        verify(outcome.accepted);
      }) as ConnectConfig["hostVerifier"];

      return await new Promise<SSHConnectResult>((resolve) => {
        if (!this.sshClient) {
          resolve({ ok: false, message: "SSH Connection Error: client not initialized" });
          return;
        }

        // A rejected promise here used to escape the enclosing try/catch (it is
        // asynchronous), so a connection failure surfaced as an unhandled
        // rejection in the MCP server rather than a tool error. Both paths now
        // resolve with a result object.
        let settled = false;
        const settle = (result: SSHConnectResult) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutId);
          resolve(result);
        };

        const timeoutId = setTimeout(() => {
          if (this.sshClient && !this.connected) {
            this.sshClient.end();
            settle({
              ok: false,
              message: `SSH Connection Error: Connection timeout after ${timeout}ms`,
            });
          }
        }, timeout);

        this.sshClient
          .on("ready", () => {
            this.connected = true;
            this.host = host;
            this.username = username;
            console.error(`SSH connection established to ${hostKeyId}`);
            settle({ ok: true, message: `Successfully connected to ${host} as ${username}` });
          })
          // `close` and `end` fire when the peer drops the session at any later
          // point. Without these handlers `connected` stayed true, so
          // `isConnected()` lied and every subsequent command failed inside ssh2
          // instead of reporting that the connection was gone.
          .on("close", () => {
            this.resetState();
            settle({
              ok: false,
              message: hostKeyFailure
                ? `SSH Connection Error: ${hostKeyFailure}`
                : "SSH Connection Error: connection closed before it was ready",
            });
          })
          .on("end", () => {
            this.resetState();
          })
          .on("error", (err) => {
            this.connected = false;
            const errorMessage = hostKeyFailure ?? err?.message ?? String(err ?? "Unknown error");
            console.error(`SSH connection error: ${errorMessage}`);
            settle({ ok: false, message: `SSH Connection Error: ${errorMessage}` });
          })
          .connect(connectOptions);
      });
    } catch (e) {
      this.connected = false;
      const errorMessage = e instanceof Error ? e.message : String(e ?? "Unknown error");
      console.error(`SSH connection exception: ${errorMessage}`);
      return { ok: false, message: `SSH Connection Error: ${errorMessage}` };
    }
  }

  /**
   * Execute a command on the connected server.
   *
   * @param command Command to execute
   * @param timeoutMs Abort the channel if the command produces no completion
   * within this many milliseconds (default: 5 minutes).
   */
  public async execute(command: string, timeoutMs: number = 300_000): Promise<SSHExecuteResult> {
    if (!this.isConnected() || !this.sshClient) {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "No active SSH connection. Please connect first.",
      };
    }

    return new Promise<SSHExecuteResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;
      const settle = (result: SSHExecuteResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        resolve(result);
      };

      // Without this, a command that never returns (a missing `-n` on a
      // long-poll, an interactive prompt) left the tool call hanging forever.
      const timeoutId = setTimeout(() => {
        settle({
          ok: false,
          exitCode: null,
          stdout,
          stderr,
          error: `Command timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      /** Appends a chunk, stopping at MAX_STREAM_BYTES so output cannot exhaust memory. */
      const append = (buffer: string, chunk: string): string => {
        if (buffer.length >= MAX_STREAM_BYTES) {
          truncated = true;
          return buffer;
        }
        const room = MAX_STREAM_BYTES - buffer.length;
        if (chunk.length > room) {
          truncated = true;
          return buffer + chunk.slice(0, room);
        }
        return buffer + chunk;
      };

      try {
        this.sshClient!.exec(command, (err, stream) => {
          if (err) {
            const errorMessage = err.message || String(err);
            console.error(`SSH command error: ${errorMessage}`);
            settle({
              ok: false,
              exitCode: null,
              stdout: "",
              stderr: "",
              error: `SSH Command Error: ${errorMessage}`,
            });
            return;
          }

          stream
            .on("close", (code: number | null) => {
              const exitCode = typeof code === "number" ? code : null;
              console.error(`Command completed with exit code: ${exitCode ?? "unknown"}`);
              settle({
                ok: exitCode === 0,
                exitCode,
                stdout: truncated ? `${stdout}\n[output truncated]` : stdout,
                stderr: truncated ? `${stderr}\n[output truncated]` : stderr,
              });
            })
            // Per-chunk output used to be echoed to stderr. The MCP server's
            // stderr is captured by the host application and often persisted, so
            // every line a remote command printed — env dumps, tokens, key
            // material — was copied into logs the user never asked to keep. The
            // output is still returned to the caller; it is simply not logged.
            .on("data", (data: Buffer) => {
              stdout = append(stdout, data.toString());
            })
            .stderr.on("data", (data: Buffer) => {
              stderr = append(stderr, data.toString());
            });
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`SSH execute exception: ${errorMessage}`);
        settle({
          ok: false,
          exitCode: null,
          stdout,
          stderr,
          error: `SSH Execution Error: ${errorMessage}`,
        });
      }
    });
  }

  /** Clears cached connection state after the transport goes away. */
  private resetState(): void {
    this.connected = false;
    this.host = null;
    this.username = null;
  }

  /**
   * Close SSH connection
   */
  public async disconnect(): Promise<void> {
    if (this.sshClient) {
      // `removeAllListeners` prevents the handlers registered by a previous
      // `connect` call from firing against the next connection attempt, which is
      // how a stale `close` event could settle a fresh promise.
      this.sshClient.removeAllListeners();
      this.sshClient.end();
      this.sshClient = null;
    }
    this.resetState();
  }

  /**
   * Get current connection information
   */
  public getConnectionInfo(): string {
    if (this.isConnected()) {
      return `Connected to ${this.host} as ${this.username}`;
    }
    return "Not connected";
  }
}

// Export the singleton instance
export const sshManager = SSHManager.getInstance();
