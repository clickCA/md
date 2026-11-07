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
