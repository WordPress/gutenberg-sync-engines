import { lock } from './lock-unlock';
import { observeStoreActions } from './action-observers';

export const privateApis = {};
lock( privateApis, { observeStoreActions } );
