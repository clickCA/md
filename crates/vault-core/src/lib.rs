pub mod db;
pub mod git_backend;
pub mod gix_backend;
pub mod merge;
pub mod sync;
pub mod vault;

pub use sync::{sync, SyncOutcome};
pub use vault::Vault;
