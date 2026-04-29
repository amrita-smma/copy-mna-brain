/**
 * Shared logger for agents.
 */
type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

class Logger {
  private level: LogLevel;
  private name: string;

  constructor(name: string = "app") {
    this.name = name;
    const envLevel = (process.env.LOG_LEVEL || "INFO").toUpperCase() as LogLevel;
    this.level = LOG_LEVELS[envLevel] !== undefined ? envLevel : "INFO";
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatMessage(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    return `${timestamp} - ${this.name} - ${level} - ${message}`;
  }

  debug(message: string): void {
    if (this.shouldLog("DEBUG")) {
      console.log(this.formatMessage("DEBUG", message));
    }
  }

  info(message: string): void {
    if (this.shouldLog("INFO")) {
      console.log(this.formatMessage("INFO", message));
    }
  }

  warn(message: string): void {
    if (this.shouldLog("WARN")) {
      console.warn(this.formatMessage("WARN", message));
    }
  }

  error(message: string): void {
    if (this.shouldLog("ERROR")) {
      console.error(this.formatMessage("ERROR", message));
    }
  }
}

export const logger = new Logger("mna-agent");
