//! Debug Envia.com.app can load Vite (`http://localhost:1420`) for HMR while
//! still owning `tendencys://`. Release builds never use this path.
//!
//! `tauri dev` is the wrong binary on macOS (no scheme registration). This
//! lets the bundled debug `.app` attach to the same Vite server instead.

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub const VITE_DEV_PORT: u16 = 1420;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(200);

pub fn is_tcp_open(addr: SocketAddr) -> bool {
    TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).is_ok()
}

pub fn vite_dev_addr() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], VITE_DEV_PORT))
}

/// `http://localhost:1420/` when this is a debug build and Vite is listening.
pub fn vite_dev_url() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    if !is_tcp_open(vite_dev_addr()) {
        return None;
    }
    Some(format!("http://localhost:{VITE_DEV_PORT}/"))
}

/// Bundled `index.html` unless a debug Vite server is up.
pub fn shell_webview_url() -> tauri::WebviewUrl {
    match vite_dev_url().and_then(|u| u.parse().ok()) {
        Some(url) => tauri::WebviewUrl::External(url),
        None => tauri::WebviewUrl::App("index.html".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn reports_open_when_listener_accepts() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        assert!(is_tcp_open(addr));
    }

    #[test]
    fn reports_closed_after_listener_drops() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            listener.local_addr().expect("addr").port()
        };
        assert!(!is_tcp_open(SocketAddr::from(([127, 0, 0, 1], port))));
    }

    #[test]
    fn vite_url_none_when_port_is_closed() {
        if is_tcp_open(vite_dev_addr()) {
            return;
        }
        assert_eq!(vite_dev_url(), None);
    }

    #[test]
    fn vite_url_is_localhost_when_port_open() {
        let _hold = TcpListener::bind(vite_dev_addr()).ok();
        if !is_tcp_open(vite_dev_addr()) {
            assert_eq!(vite_dev_url(), None);
            return;
        }
        if cfg!(debug_assertions) {
            assert_eq!(vite_dev_url().as_deref(), Some("http://localhost:1420/"));
        } else {
            assert_eq!(vite_dev_url(), None);
        }
    }
}
