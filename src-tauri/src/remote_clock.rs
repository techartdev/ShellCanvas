// SPDX-License-Identifier: MPL-2.0
use crate::{ConnectionIdentity, DesktopState, ServiceRole};
use shellcanvas_services::HostClockSample;

#[tauri::command]
pub async fn read_host_clock(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    state: tauri::State<'_, DesktopState>,
) -> Result<HostClockSample, String> {
    let source = {
        let registry = state.registry.lock().await;
        let session = registry
            .sessions
            .get(&session_id)
            .ok_or("Workspace is disconnected")?;
        session.check_source(&ServiceRole::Console, binding.as_ref())?;
        session
            .service_connection(&ServiceRole::Console)
            .ok_or("No clock source")?
    };
    let clock = source.clock.as_ref().ok_or("Remote clock unavailable")?;
    // Never hold the workspace registry lock across remote I/O.
    let sample = clock.read().await.map_err(|error| error.to_string())?;
    let registry = state.registry.lock().await;
    let session = registry
        .sessions
        .get(&session_id)
        .ok_or("Workspace is disconnected")?;
    session.check_source(&ServiceRole::Console, Some(source.identity()))?;
    Ok(sample)
}
