import { Event } from "@aptos-labs/ts-sdk";

export enum ErrorSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  FATAL = 'FATAL'
}

export enum TweetReplyErrorCode {
  BLOCK_NOT_MINED = "BLOCK_NOT_MINED",
  EVENT_PROCESSING_FAILED = "EVENT_PROCESSING_FAILED",
  CIRCUIT_BREAKER_OPEN = "CIRCUIT_BREAKER_OPEN",
  INVALID_BLOCK_CONFIG = "INVALID_BLOCK_CONFIG",
  ACTION_PROCESSING_FAILED = "ACTION_PROCESSING_FAILED"
}

export interface TweetReplyEvent {
  user: string;
  tweet_link: string;
  status: string;
  amount_paid: string;
}

export interface BlockFetcherConfig {
  startHeight: number;
  endHeight: number;
  batchSize: number;
  maxRetries: number;
  retryDelay: number;
}

export interface ProcessedEvent {
  eventHash: string;
  blockNumber: number;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  retryCount: number;
}

export interface BlockFetchResult {
  events: Event[];
  status: 'MINED' | 'NOT_MINED' | 'ERROR';
  error?: string;
} 