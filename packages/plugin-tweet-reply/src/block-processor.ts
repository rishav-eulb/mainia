import { Aptos } from "@aptos-labs/ts-sdk";
import { elizaLogger, IAgentRuntime, Memory, stringToUuid } from "@elizaos/core";
import { CircuitBreaker } from "./circuit-breaker";
import { fetchBlocksWithEvents } from "./block-fetcher";
import { BlockFetcherConfig, ProcessedEvent, TweetReplyEvent } from "./types";
import { defaultTweetReplyTemplate } from "./templates";
import { updateLastProcessedHeight} from "./storage";
import { EventStateService } from "./services/event-state";

const COMPLETION_TIMEOUT = 30000; // 30 seconds timeout
const INSTANCE_ID = stringToUuid('block-processor-instance'); // Unique ID for this instance

export class BlockProcessor {
  private currentBlock: number;
  private circuitBreaker: CircuitBreaker;
  private isProcessing: boolean = false;
  private readonly MAX_RETRIES = 3;
  private eventStateService: EventStateService;

  constructor(startBlock: number) {
    this.currentBlock = startBlock;
    this.circuitBreaker = new CircuitBreaker();
    this.eventStateService = new EventStateService();
  }

  async processBlock(
    aptosClient: Aptos,
    botPortalAddress: string,
    runtime: IAgentRuntime
  ): Promise<void> {
    if (this.isProcessing) {
      elizaLogger.debug("Block processing already in progress", { block: this.currentBlock });
      return;
    }

    this.isProcessing = true;
    await this.eventStateService.initialize(runtime);

    try {
      await this.circuitBreaker.execute(async () => {
        const blockFetcherConfig: BlockFetcherConfig = {
          startHeight: this.currentBlock,
          endHeight: this.currentBlock,
          batchSize: 1,
          maxRetries: 3,
          retryDelay: 1000
        };

        const result = await fetchBlocksWithEvents(
          aptosClient,
          botPortalAddress,
          blockFetcherConfig
        );

        if (result.status === 'NOT_MINED' || result.status === 'ERROR') {
          elizaLogger.debug("Block not ready", { 
            height: this.currentBlock,
            status: result.status,
            error: result.status === 'ERROR' ? result.error : undefined
          });
          return;
        }

        // Process events
        const blockEvents = result.events.map(event => {
            const eventData = event.data as TweetReplyEvent;
            const tweet_link = eventData.tweet_link.startsWith('http') ? 
                eventData.tweet_link : 
                `https://twitter.com/i/web/status/${eventData.tweet_link}`;
            
            // Create deterministic roomId that will be consistent across retries
            const roomId = stringToUuid(`tweet-reply-${eventData.user}-${tweet_link}`);
            
            return {
                roomId,
                event: {
                    ...event,
                    data: {
                        ...eventData,
                        tweet_link
                    }
                }
            };
        });

        let blockCompleted = true;

        // Process each event
        for (const { roomId, event } of blockEvents) {
            const eventData = event.data as TweetReplyEvent;
            
            // Check if already completed using roomId
            const isCompleted = await this.eventStateService.isEventCompleted(roomId);
            const tweetId = await this.eventStateService.getEventTweetId(roomId);
            
            if (isCompleted && tweetId) {
                elizaLogger.info("Event already completed", { 
                    roomId,
                    tweetId,
                    tweet_link: eventData.tweet_link
                });
                continue;
            }

            // Try to claim the event
            if (await this.eventStateService.claimEvent(roomId)) {
                try {
                    const memory: Memory = {
                        id: stringToUuid(new Date().toISOString()),
                        content: {
                            tweet_link: eventData.tweet_link,
                            user: eventData.user,
                            template: defaultTweetReplyTemplate,
                            text: `Reply to tweet: ${eventData.tweet_link} for user ${eventData.user}`,
                            action: "TWEET_REPLY"
                        },
                        userId: runtime.agentId,
                        agentId: runtime.agentId,
                        roomId: roomId
                    };

                    await runtime.processActions(memory, [memory]);
                    
                    // Check completion after processing
                    const completedAfterProcessing = await this.eventStateService.isEventCompleted(roomId);
                    const finalTweetId = await this.eventStateService.getEventTweetId(roomId);
                    
                    if (completedAfterProcessing && finalTweetId) {
                        elizaLogger.info("Event completed successfully after processing", { 
                            roomId,
                            tweetId: finalTweetId
                        });
                    } else {
                        blockCompleted = false;
                        elizaLogger.warn("Event not marked as completed after processing", {
                            roomId
                        });
                    }
                } catch (error) {
                    elizaLogger.error("Error processing event", {
                        roomId,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    blockCompleted = false;
                }
            } else {
                elizaLogger.debug("Could not claim event", { roomId });
                blockCompleted = false;
            }
        }

        // Check final block status
        const completionStatus = await Promise.all(
            blockEvents.map(async ({ roomId }) => {
                const isCompleted = await this.eventStateService.isEventCompleted(roomId);
                const tweetId = await this.eventStateService.getEventTweetId(roomId);
                return {
                    roomId,
                    completed: isCompleted && !!tweetId
                };
            })
        );

        const successful = completionStatus.filter(s => s.completed).length;
        const total = blockEvents.length;

        elizaLogger.info("Block processing status", {
          block: this.currentBlock,
          total,
          successful,
          blockCompleted
        });

        if (blockCompleted || successful === total) {
          await updateLastProcessedHeight(runtime, this.currentBlock);
          this.currentBlock++;
        }
      });
    } catch (error) {
      elizaLogger.error("Circuit breaker triggered", {
        block: this.currentBlock,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.isProcessing = false;
    }
  }
}
