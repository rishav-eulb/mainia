import { Service, IAgentRuntime, elizaLogger, stringToUuid, Memory, Content } from "@elizaos/core";
import { CircuitBreaker } from "../circuit-breaker";

const COMPLETION_ROOM_ID = stringToUuid('tweet-reply-completions');
const CLAIM_ROOM_ID = stringToUuid('tweet-reply-claims');

interface TweetReplyContent extends Content {
    type: 'tweet-reply-request' | 'tweet-reply-completion' | 'tweet-reply-claim';
    status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
    timestamp: string;
    text: string;
    eventHash?: string;
    tweetId?: string;
    error?: string;
    completed?: boolean;
    roomId: string;
}

type TweetReplyMemory = Memory & {
    content: TweetReplyContent;
};

function normalizeRoomId(roomId: string): `${string}-${string}-${string}-${string}-${string}` {
    if (roomId.includes('-')) return roomId as `${string}-${string}-${string}-${string}-${string}`;
    return stringToUuid(roomId);
}

export class EventStateService extends Service {
    private runtime: IAgentRuntime | null = null;
    private circuitBreaker: CircuitBreaker;
    private readonly LOCK_TIMEOUT = 30000; // 30 seconds

    constructor() {
        super();
        this.circuitBreaker = new CircuitBreaker(3, 30000);
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        this.runtime = runtime;
        // Initialize the completion room if it doesn't exist
        try {
            await this.ensureCompletionRoom();
        } catch (error) {
            elizaLogger.error("Failed to initialize completion room", { error });
        }
    }

    private async ensureCompletionRoom(): Promise<void> {
        if (!this.runtime) return;

        try {
            const completions = await this.runtime.messageManager.getMemoriesByRoomIds({
                roomIds: [COMPLETION_ROOM_ID]
            });
            if (completions.length === 0) {
                // Create an initialization marker in the completion room
                const initMarker: Memory = {
                    id: stringToUuid(new Date().toISOString()),
                    content: {
                        type: 'tweet-reply-completion' as const,
                        status: 'COMPLETED' as const,
                        timestamp: new Date().toISOString(),
                        text: 'Completion room initialized',
                        completed: true,
                        roomId: COMPLETION_ROOM_ID
                    },
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    roomId: COMPLETION_ROOM_ID
                };
                await this.runtime.messageManager.createMemory(initMarker);
                elizaLogger.info("Initialized completion room");
            }
        } catch (error) {
            elizaLogger.error("Failed to ensure completion room", { error });
            throw error;
        }
    }

    async claimEvent(roomId: string): Promise<boolean> {
        if (!this.runtime) return false;

        try {
            // Ensure roomId is in UUID format
            const normalizedRoomId = normalizeRoomId(roomId);
            
            const claims = await this.runtime.messageManager.getMemoriesByRoomIds({ 
                roomIds: [normalizedRoomId] 
            });
            
            // Check for existing valid claims
            const validClaim = claims.find(claim => {
                if (claim.content.type === 'tweet-reply-claim') {
                    const timestamp = claim.content.timestamp;
                    if (typeof timestamp === 'string') {
                        const claimTime = new Date(timestamp);
                        return Date.now() - claimTime.getTime() < this.LOCK_TIMEOUT;
                    }
                }
                return false;
            });

            if (validClaim) {
                elizaLogger.debug("Event already claimed", { roomId });
                return false;
            }

            // Create new claim
            const claim: Memory = {
                id: stringToUuid(new Date().toISOString()),
                content: {
                    timestamp: new Date().toISOString(),
                    type: 'tweet-reply-claim' as const,
                    text: `Claim for tweet reply in room ${roomId}`,
                    status: 'IN_PROGRESS' as const,
                    roomId: normalizedRoomId
                },
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                roomId: normalizedRoomId
            };

            await this.runtime.messageManager.createMemory(claim);
            elizaLogger.debug("Successfully claimed event", { roomId });
            return true;
        } catch (error) {
            elizaLogger.error("Failed to claim event", { roomId, error });
            return false;
        }
    }

    async markEventComplete(roomId: string, tweetId: string): Promise<void> {
        if (!this.runtime) return;

        try {
            const normalizedRoomId = normalizeRoomId(roomId);
            
            const completion: Memory = {
                id: stringToUuid(new Date().toISOString()),
                content: {
                    type: 'tweet-reply-completion',
                    status: 'COMPLETED',
                    timestamp: new Date().toISOString(),
                    text: `Tweet reply completed for tweet ${tweetId}`,
                    tweetId,
                    completed: true,
                    roomId: normalizedRoomId
                },
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                roomId: normalizedRoomId
            };

            await this.runtime.messageManager.createMemory(completion);

        } catch (error) {
            elizaLogger.error("Failed to mark event as complete", { roomId, error });
            throw error;
        }
    }

    async markEventFailed(roomId: string, error: string): Promise<void> {
        if (!this.runtime) return;

        try {
            const normalizedRoomId = normalizeRoomId(roomId);
            const content: TweetReplyContent = {
                timestamp: new Date().toISOString(),
                type: 'tweet-reply-completion' as const,
                text: `Tweet reply failed: ${error}`,
                status: 'FAILED' as const,
                error,
                completed: false,
                roomId: normalizedRoomId
            };

            const completion: Memory = {
                id: stringToUuid(new Date().toISOString()),
                content,
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                roomId: normalizedRoomId
            };

            await this.runtime.messageManager.createMemory(completion);
            elizaLogger.info("Successfully marked event as failed", { roomId: normalizedRoomId, error });
        } catch (err) {
            elizaLogger.error("Failed to mark event as failed", { roomId, error, err });
            throw err;
        }
    }

    async isEventCompleted(roomId: string): Promise<boolean> {
        if (!this.runtime) return false;

        try {
            const normalizedRoomId = normalizeRoomId(roomId);
            
            // Just check for a completion record in this room
            const roomMemories = await this.runtime.messageManager.getMemoriesByRoomIds({ 
                roomIds: [normalizedRoomId] 
            });

            // Simple completion check - just look for a COMPLETED status
            return roomMemories.some(m => 
                m.content.type === 'tweet-reply-completion' && 
                m.content.status === 'COMPLETED'
            );

        } catch (error) {
            elizaLogger.error("Error checking event completion", { roomId, error });
            return false;
        }
    }

    async getEventTweetId(roomId: string): Promise<string | null> {
        if (!this.runtime) return null;

        try {
            // Ensure roomId is in UUID format
            const normalizedRoomId = normalizeRoomId(roomId);
            
            // Check in the specific room first
            const roomMemories = await this.runtime.messageManager.getMemoriesByRoomIds({ 
                roomIds: [normalizedRoomId] 
            });
            
            const roomCompletion = roomMemories.find(m => 
                m.content.type === 'tweet-reply-completion' && 
                m.content.status === 'COMPLETED' &&
                'tweetId' in m.content &&
                typeof m.content.tweetId === 'string'
            ) as TweetReplyMemory | undefined;

            if (roomCompletion?.content.tweetId) {
                elizaLogger.debug("Found tweet ID in event room", {
                    roomId: normalizedRoomId,
                    tweetId: roomCompletion.content.tweetId
                });
                return roomCompletion.content.tweetId;
            }

            // Get the event hash from the request
            const requestMemory = roomMemories.find(m => 
                m.content.type === 'tweet-reply-request' && 
                'eventHash' in m.content
            ) as TweetReplyMemory | undefined;

            const eventHash = requestMemory?.content.eventHash;
            if (!eventHash) {
                elizaLogger.debug("No event hash found for tweet ID lookup", { roomId: normalizedRoomId });
                return null;
            }

            // Check in the global completions room
            const globalCompletions = await this.runtime.messageManager.getMemoriesByRoomIds({
                roomIds: [COMPLETION_ROOM_ID]
            });

            const completedElsewhere = globalCompletions.find(m => 
                m.content.type === 'tweet-reply-completion' && 
                m.content.status === 'COMPLETED' &&
                'eventHash' in m.content &&
                m.content.eventHash === eventHash &&
                'tweetId' in m.content &&
                typeof m.content.tweetId === 'string'
            ) as TweetReplyMemory | undefined;
            
            if (completedElsewhere?.content.tweetId) {
                elizaLogger.debug("Found tweet ID in global room", {
                    roomId: normalizedRoomId,
                    eventHash,
                    tweetId: completedElsewhere.content.tweetId
                });
                return completedElsewhere.content.tweetId;
            }

            elizaLogger.debug("No tweet ID found", { roomId: normalizedRoomId, eventHash });
            return null;
        } catch (error) {
            elizaLogger.error("Error getting event tweet ID", { roomId: normalizedRoomId, error });
            return null;
        }
    }
} 