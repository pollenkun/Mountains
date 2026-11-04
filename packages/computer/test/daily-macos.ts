/** Disabled before any process starts. Local account isolation, original-data
 * inventories and exact-ID cleanup must be implemented and independently reviewed. */
import {requireRealMachineAcceptanceSafety} from './acceptance/safety-gate.ts';
requireRealMachineAcceptanceSafety();
