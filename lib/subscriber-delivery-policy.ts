// Daily delivery requires protected enrollment. The sender and the
// provider claim both recheck enrollment. Setting this literal to false is
// the global emergency pause for every subscriber-letter path. There is no
// environment override. The workflow allows scheduled and manual runs only.
export const SUBSCRIBER_LETTERS_ENABLED: boolean = true;

// Direct reader-triggered generation stays paused during the private rollout.
export const INTERACTIVE_LETTERS_ENABLED: boolean = false;
