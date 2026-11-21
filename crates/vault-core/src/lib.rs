pub mod db;
pub mod exclude;
pub mod git_backend;
pub mod gix_backend;
pub mod history;
pub mod links;
pub mod merge;
pub mod sync;
pub mod vault;

pub use sync::{clone_with, sync, SyncOutcome};
pub use vault::Vault;

/// Fault-injection hook for crash tests (see `tests/kill_tests.rs` and the
/// write tests): abort the process when `VAULT_SPIKE_ABORT_STATE` names the
/// persistence state about to complete. Production never sets the variable,
/// so this compiles down to one env read per write.
pub(crate) fn abort_point(state: &str) {
    if let Ok(s) = std::env::var("VAULT_SPIKE_ABORT_STATE") {
        if s == state {
            eprintln!("VAULT_SPIKE_ABORT_STATE={state}: aborting");
            std::process::abort();
        }
    }
}
