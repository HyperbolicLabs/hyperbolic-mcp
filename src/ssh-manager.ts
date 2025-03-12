import * as fs from "fs";
import { NodeSSH } from "node-ssh";

/**
 * Singleton class to manage SSH connections
 */
class SSHManager {
  private static instance: SSHManager;
  private sshClient: NodeSSH | null = null;
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
    if (this.sshClient && this.connected) {
      try {
        // Test the connection
        this.sshClient.execCommand("echo 1");
        return true;
      } catch {
        this.connected = false;
      }
    }
    return false;
  }

  /**
   * Establish SSH connection
   * @param host Hostname or IP address of the remote server
   * @param username SSH username for authentication
   * @param password Optional SSH password for authentication
   * @param privateKeyPath Optional path to private key file
   * @param port SSH port number (default: 22)
   */
  public async connect(
    host: string,
    username: string,
    password?: string,
    privateKeyPath?: string,
    port: number = 22
  ): Promise<string> {
    try {
      // Close existing connection if any
      await this.disconnect();

      // Initialize new client
      this.sshClient = new NodeSSH();

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
      };

      if (password) {
        connectOptions.password = password;
      } else {
        const keyPath = privateKeyPath || expandedDefaultKeyPath;
        const expandedKeyPath = keyPath.replace(/^~/, process.env.HOME || "");

        if (!fs.existsSync(expandedKeyPath)) {
          return `SSH Key Error: Key file not found at ${expandedKeyPath}`;
        }

        connectOptions.privateKey = fs.readFileSync(expandedKeyPath, "utf8");
      }

      await this.sshClient.connect(connectOptions);
      this.connected = true;
      this.host = host;
      this.username = username;
      return `Successfully connected to ${host} as ${username}`;
    } catch (e) {
      this.connected = false;
      return `SSH Connection Error: ${
        e instanceof Error ? e.message : String(e)
      }`;
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

    try {
      const result = await this.sshClient.execCommand(command);

      if (result.stderr) {
        return `Error: ${result.stderr}\nOutput: ${result.stdout}`;
      }

      return result.stdout;
    } catch (e) {
      this.connected = false;
      return `SSH Command Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Close SSH connection
   */
  public async disconnect(): Promise<void> {
    if (this.sshClient) {
      try {
        this.sshClient.dispose();
      } catch {
        // Ignore errors during disconnect
      }
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
