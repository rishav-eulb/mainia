import { IAgentRuntime, elizaLogger, stringToUuid } from "@elizaos/core";
import { heightState } from "./heightState";
import { CURRENT_HEIGHT } from "./constants";
import * as fs from 'fs';
import * as path from 'path';

const STORAGE_KEY = stringToUuid("tweetayzbced_heigghtt");
const STORAGE_FILE = path.join(process.cwd(), 'data', 'last_processed_height.json');

// Ensure data directory exists
try {
    const dataDir = path.dirname(STORAGE_FILE);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
} catch (error) {
    elizaLogger.error("Failed to create data directory", { error });
}

// Initialize height state from file or fallback to constants
function initializeHeight(): number {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const data = fs.readFileSync(STORAGE_FILE, 'utf8');
            const stored = JSON.parse(data);
            elizaLogger.info("Loaded height from storage file", { height: stored.height });
            return parseInt(stored.height);
        }
    } catch (error) {
        elizaLogger.warn("Failed to read storage file, using default height", { error });
    }
    return CURRENT_HEIGHT;
}

heightState.current = initializeHeight();
elizaLogger.info("Initialized height state", { currentHeight: heightState.current });

export async function getLastProcessedHeight(runtime: IAgentRuntime): Promise<number> {
    try {
        // First try to read from file
        if (fs.existsSync(STORAGE_FILE)) {
            const data = fs.readFileSync(STORAGE_FILE, 'utf8');
            const stored = JSON.parse(data);
            const height = parseInt(stored.height);
            heightState.current = height;
            return height;
        }

        // Fallback to memory manager
        const stored = await runtime.messageManager.getMemoryById(STORAGE_KEY);
        const height = stored ? parseInt((stored.content as unknown as { height: string }).height) : heightState.current;
        heightState.current = height;
        return height;
    } catch (error) {
        elizaLogger.warn("Failed to get last processed height, using current height", { 
            error: error.message,
            currentHeight: heightState.current 
        });
        return heightState.current;
    }
}

export async function updateLastProcessedHeight(runtime: IAgentRuntime, height: number): Promise<void> {
    try {
        // Update file storage first
        const data = JSON.stringify({
            height: height.toString(),
            lastUpdated: new Date().toISOString()
        }, null, 2);
        
        fs.writeFileSync(STORAGE_FILE, data);

        // Update memory storage
        await runtime.messageManager.createMemory({
            id: STORAGE_KEY,
            content: { 
                height: height.toString(),
                text: `Last processed height: ${height}`
            },
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: runtime.agentId
        });
        
        // Update in-memory state
        heightState.current = height;
        process.env.CURRENT_HEIGHT = height.toString();
        
        elizaLogger.debug("Updated last processed height", { 
            height,
            file: STORAGE_FILE
        });
    } catch (error) {
        elizaLogger.error("Failed to update last processed height", {
            error: error.message,
            height
        });
    }
}

export function getCurrentHeight(): number {
    return heightState.current;
} 