interface Logger {
  info: (message: string, ...args: any[]) => void;
  warn: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
  debug: (message: string, ...args: any[]) => void;
}

class SimpleLogger implements Logger {
  private getTimestamp(): string {
    return new Date().toISOString();
  }

  private formatMessage(
    level: string,
    message: string,
    ...args: any[]
  ): string {
    const timestamp = this.getTimestamp();
    const argsStr =
      args.length > 0
        ? " " +
          args
            .map((arg) =>
              typeof arg === "object"
                ? JSON.stringify(arg, null, 2)
                : String(arg)
            )
            .join(" ")
        : "";
    return `[${timestamp}] [${level}] ${message}${argsStr}`;
  }

  info(message: string, ...args: any[]): void {
    console.log(this.formatMessage("INFO", message, ...args));
  }

  warn(message: string, ...args: any[]): void {
    console.warn(this.formatMessage("WARN", message, ...args));
  }

  error(message: string, ...args: any[]): void {
    console.error(this.formatMessage("ERROR", message, ...args));
  }

  debug(message: string, ...args: any[]): void {
    if (process.env.NODE_ENV === "development") {
      console.debug(this.formatMessage("DEBUG", message, ...args));
    }
  }
}

export const logger: Logger = new SimpleLogger();
