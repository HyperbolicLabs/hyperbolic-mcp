import * as fs from "fs";
import { Client } from "ssh2";

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
   * Establish SSH connection
   * @param host Hostname or IP address of the remote server
   * @param username SSH username for authentication
   * @param password Optional SSH password for authentication
   * @param privateKeyPath Optional path to private key file
   * @param port SSH port number (default: 22)
   * @param timeout Connection timeout in milliseconds (default: 10000)
   */
  public async connect(
    host: string,
    username: string,
    password?: string,
    privateKeyPath?: string,
    port: number = 22,
    timeout: number = 10000
  ): Promise<string> {
    try {
      // Close existing connection if any
      await this.disconnect();

      // Initialize new client
      this.sshClient = new Client();

      // Get default key path from environment
      const defaultKeyPath =
        process.env.SSH_PRIVATE_KEY_PATH || "~/.ssh/id_rsa";
      const expandedDefaultKeyPath = defaultKeyPath.replace(
        /^~/,
        process.env.HOME || ""
      );

      // Connect options
      let connectOptions: any = {
        host,
        port,
        username,
        readyTimeout: timeout,
        debug: (message: string) => console.log(`SSH Debug: ${message}`),
      };

      if (password) {
        connectOptions.password = password;
      } else {
        const keyPath = privateKeyPath || expandedDefaultKeyPath;
        const expandedKeyPath = keyPath.replace(/^~/, process.env.HOME || "");

        if (!fs.existsSync(expandedKeyPath)) {
          return `SSH Key Error: Key file not found at ${expandedKeyPath}`;
        }

        try {
          connectOptions.privateKey = fs.readFileSync(expandedKeyPath);
        } catch (error) {
          return `SSH Key Error: Failed to read key file ${expandedKeyPath}: ${error}`;
        }
      }

      console.log(`Attempting to connect to ${host}:${port} as ${username}`);

      return new Promise<string>((resolve, reject) => {
        if (!this.sshClient) {
          reject("SSH client not initialized");
          return;
        }

        // Set a connection timeout
        const timeoutId = setTimeout(() => {
          if (this.sshClient && !this.connected) {
            this.sshClient.end();
            reject(
              `SSH Connection Error: Connection timeout after ${timeout}ms`
            );
          }
        }, timeout);

        this.sshClient
          .on("ready", () => {
            clearTimeout(timeoutId);
            this.connected = true;
            this.host = host;
            this.username = username;
            console.log(`SSH connection established to ${host}`);
            resolve(`Successfully connected to ${host} as ${username}`);
          })
          .on("error", (err) => {
            clearTimeout(timeoutId);
            this.connected = false;
            const errorMessage = err
              ? err.message || String(err)
              : "Unknown error";
            console.error(`SSH connection error: ${errorMessage}`);
            reject(`SSH Connection Error: ${errorMessage}`);
          })
          .connect(connectOptions);
      });
    } catch (e) {
      this.connected = false;
      const errorMessage = e
        ? e instanceof Error
          ? e.message
          : String(e)
        : "Unknown error";
      console.error(`SSH connection exception: ${errorMessage}`);
      return `SSH Connection Error: ${errorMessage}`;
    }
  }

  /**
   * Execute command on connected server
   * @param command Command to execute
   */
  public async execute(command: string): Promise<string> {
    if (!this.isConnected() || !this.sshClient) {
      return "Error: No active SSH connection. Please connect first.";
    }

    console.log(`Executing command: ${command}`);

    return new Promise<string>((resolve) => {
      try {
        this.sshClient!.exec(command, (err, stream) => {
          if (err) {
            this.connected = false;
            const errorMessage = err.message || String(err);
            console.error(`SSH command error: ${errorMessage}`);
            resolve(`SSH Command Error: ${errorMessage}`);
            return;
          }

          let stdout = "";
          let stderr = "";

          stream
            .on("close", (code: number) => {
              console.log(`Command completed with exit code: ${code}`);
              if (stderr) {
                resolve(`Error: ${stderr}\nOutput: ${stdout}`);
              } else {
                resolve(stdout);
              }
            })
            .on("data", (data: Buffer) => {
              const chunk = data.toString();
              stdout += chunk;
              if (chunk.trim()) {
                console.log(`SSH stdout: ${chunk.trim()}`);
              }
            })
            .stderr.on("data", (data: Buffer) => {
              const chunk = data.toString();
              stderr += chunk;
              if (chunk.trim()) {
                console.error(`SSH stderr: ${chunk.trim()}`);
              }
            });
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(`SSH execute exception: ${errorMessage}`);
        resolve(`SSH Execution Error: ${errorMessage}`);
      }
    });
  }

  /**
   * Close SSH connection
   */
  public async disconnect(): Promise<void> {
    if (this.sshClient) {
      this.sshClient.end();
    }
    this.connected = false;
    this.host = null;
    this.username = null;
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
