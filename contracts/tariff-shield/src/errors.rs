use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    ImporterNotRegistered = 3,
    ImporterAlreadyRegistered = 4,
    InvalidAmount = 5,
    CollateralBelowRequired = 6,
    AccountFrozen = 7,
    NotAnAdmin = 8,
    ProposalNotFound = 9,
    ProposalExpired = 10,
    AlreadyVoted = 11,
    StaleOracleError = 12,
    RateLimitExceededError = 13,
    OracleCallFailed = 14,
    // #339 — oracle role is separate from general admin; caller used wrong role
    UnauthorizedRole = 15,
    UnauthorizedEmergencyOverride = 16,
    // #326 — new required_collateral would exceed 5× the previous value in one update
    CollateralCapExceeded = 17,
    // #336 — importer tried to raise a dispute outside the 72-hour window
    NoDisputeWindow = 18,
    // #336 — dispute already raised for this importer's current update
    DisputeAlreadyRaised = 19,
    // #336 — admin tried to resolve a dispute that was never raised
    NoActiveDispute = 20,
}
