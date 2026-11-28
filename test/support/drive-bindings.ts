export const driveBindings = {
    CLIENT_ID: 'test-client-id',
    CLIENT_SECRET: 'test-client-secret',
    REFRESH_TOKEN: 'test-refresh-token-history',
};

export const workerBindings = {
    ...driveBindings,
    USERS: JSON.stringify({ test: 'pass' }),
};
