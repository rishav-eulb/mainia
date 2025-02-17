export type MediaData = {
    data: Buffer;
    mediaType: string;
};

export interface TwitterUser {
    id: string;
    screenName: string;
    name: string;
    profileImageUrl: string;
    description?: string;
    verified?: boolean;
    protected?: boolean;
    followersCount?: number;
    friendsCount?: number;
}
