import type { TwitterUser } from "../../types";
import { elizaLogger } from "@elizaos/core";

/**
 * Fetches Twitter user information for a given username or user ID
 * @param identifier - Twitter username (with or without @) or user ID
 * @param client - Twitter API client instance
 * @returns Promise<TwitterUser | null> - Returns user info or null if not found
 */
export async function fetchTwitterUser(
    identifier: string,
    client: any
): Promise<TwitterUser | null> {
    try {
        // Clean up the identifier (remove @ if present)
        const cleanIdentifier = identifier.startsWith('@') ? identifier.substring(1) : identifier;

        elizaLogger.info("Fetching Twitter user information", {
            identifier: cleanIdentifier
        });

        // Try to fetch user information
        const user = await client.v2.user(cleanIdentifier, {
            "user.fields": [
                "id",
                "name",
                "username",
                "profile_image_url",
                "description",
                "verified",
                "protected",
                "public_metrics"
            ]
        });

        if (!user || !user.data) {
            elizaLogger.warn("Twitter user not found", {
                identifier: cleanIdentifier
            });
            return null;
        }

        // Map Twitter API response to TwitterUser interface
        const twitterUser: TwitterUser = {
            id: user.data.id,
            screenName: user.data.username,
            name: user.data.name,
            profileImageUrl: user.data.profile_image_url || "",
            description: user.data.description,
            verified: user.data.verified,
            protected: user.data.protected,
            followersCount: user.data.public_metrics?.followers_count,
            friendsCount: user.data.public_metrics?.following_count
        };

        elizaLogger.info("Successfully fetched Twitter user information", {
            userId: twitterUser.id,
            screenName: twitterUser.screenName
        });

        return twitterUser;
    } catch (error) {
        elizaLogger.error("Error fetching Twitter user information", {
            error: error instanceof Error ? error.message : String(error),
            identifier
        });
        return null;
    }
} 