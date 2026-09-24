// Manual-first delivery requires protected enrollment. The sender and the
// provider claim both recheck enrollment. Setting this literal to false is
// the global emergency pause for every subscriber-letter path. There is no
// environment override, and the scheduled workflow remains off in source.
export const SUBSCRIBER_LETTERS_ENABLED: boolean = true;

// Direct reader-triggered generation stays paused during manual-first delivery.
export const INTERACTIVE_LETTERS_ENABLED: boolean = false;
