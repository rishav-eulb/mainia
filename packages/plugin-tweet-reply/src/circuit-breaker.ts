import { elizaLogger } from "@elizaos/core";
import { TweetReplyErrorCode } from "./types";

export class CircuitBreaker {
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private readonly maxFailures: number;
  private readonly resetTimeout: number;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  constructor(maxFailures: number = 3, resetTimeout: number = 30000) {
    this.maxFailures = maxFailures;
    this.resetTimeout = resetTimeout;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await operation();
      if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED';
        this.failures = 0;
      }
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();
      
      if (this.failures >= this.maxFailures) {
        this.state = 'OPEN';
      }
      throw error;
    }
  }
}
