import { Event, Aptos } from "@aptos-labs/ts-sdk";
import { elizaLogger } from "@elizaos/core";
import { BlockFetcherConfig, BlockFetchResult } from "./types";

export async function fetchBlocksWithEvents(
    client: Aptos,
    address: string,
    config: BlockFetcherConfig
): Promise<BlockFetchResult> {
    const events: Event[] = [];
    let retryCount = 0;

    try {
        elizaLogger.debug("Fetching block at height:", { height: config.startHeight });
        
        const block = await client.getBlockByHeight({
            blockHeight: config.startHeight,
            options: {
                withTransactions: true
            }
        });

        if (!block || !block.block_height) {
            elizaLogger.debug("Block not mined yet", { height: config.startHeight });
            return {
                events: [],
                status: 'NOT_MINED'
            };
        }

        if (!block.transactions) {
            elizaLogger.debug("No transactions in block", { height: config.startHeight });
            return {
                events: [],
                status: 'MINED'
            };
        }

        // Filter transactions for TweetReplyEvents
        for (const tx of block.transactions) {
            if ('events' in tx && tx.events) {
                const tweetReplyEvents = tx.events.filter(event => 
                    event.type === `${address}::actions::TweetReplyEvent`
                );

                if (tweetReplyEvents.length > 0) {
                    elizaLogger.info("Found TweetReplyEvents in block", {
                        height: config.startHeight,
                        count: tweetReplyEvents.length
                    });
                    events.push(...tweetReplyEvents);
                }
            }
        }

        return {
            events,
            status: 'MINED'
        };

    } catch (error) {
        retryCount++;
        elizaLogger.error("Error fetching block", {
            height: config.startHeight,
            error: error.message,
            retry: `${retryCount}/${config.maxRetries}`
        });

        if (retryCount >= config.maxRetries) {
            return {
                events: [],
                status: 'ERROR',
                error: `Max retries (${config.maxRetries}) exceeded while fetching block ${config.startHeight}`
            };
        }

        await new Promise(resolve => setTimeout(resolve, config.retryDelay));
        return {
            events: [],
            status: 'ERROR',
            error: error.message
        };
    }
}
