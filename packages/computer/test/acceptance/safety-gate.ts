// Deliberately no environment-variable override. The account adapter and signed
// controller evidence are not implemented yet. A diagnostic flag is not a bypass.
export function requireRealMachineAcceptanceSafety():void{
 throw new Error('Real-machine daily/acceptance entry points are disabled until local-account isolation, original-data inventories, exact-ID deletion and failure cleanup are implemented and independently reviewed. No fixture or browser was started.');
}
