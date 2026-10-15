use crate::{config, service::Service};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path as RoutePath, Query, State},
    http::{HeaderMap, StatusCode, Uri, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use dewbow_protocol::{error, id};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    fs,
    path::Path,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
include!(concat!(env!("OUT_DIR"), "/web.rs"));

pub fn failure(cause: anyhow::Error) -> Response {
    let detail = cause
        .downcast_ref::<dewbow_protocol::ManagementError>()
        .cloned()
        .unwrap_or_else(|| {
            error(
                "EXECUTION_FAILED",
                "Request failed; inspect local configuration.",
            )
        });
    let status = match detail.code.as_str() {
        "UNAUTHORIZED" => StatusCode::UNAUTHORIZED,
        "FORBIDDEN" => StatusCode::FORBIDDEN,
        "NOT_FOUND" => StatusCode::NOT_FOUND,
        _ => StatusCode::BAD_REQUEST,
    };
    (status, Json(json!({"error":detail}))).into_response()
}
fn host(service: &Service, headers: &HeaderMap) -> bool {
    headers.get(header::HOST).and_then(|h| h.to_str().ok())
        == Some(format!("127.0.0.1:{}", service.config.port).as_str())
}
fn origin(service: &Service, headers: &HeaderMap) -> bool {
    headers.get(header::ORIGIN).and_then(|h| h.to_str().ok())
        == Some(format!("http://127.0.0.1:{}", service.config.port).as_str())
}
fn constant_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |v, (a, b)| v | (a ^ b)) == 0
}
fn control(service: &Service, headers: &HeaderMap) -> bool {
    host(service, headers)
        && headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|v| constant_equal(v, &format!("Bearer {}", service.config.control_token)))
        && headers
            .get(header::ORIGIN)
            .is_none_or(|_| origin(service, headers))
}
fn operator(service: &Service, headers: &HeaderMap) -> bool {
    if !host(service, headers)
        || headers
            .get(header::ORIGIN)
            .is_some_and(|_| !origin(service, headers))
    {
        return false;
    }
    let token = headers
        .get(header::COOKIE)
        .and_then(|h| h.to_str().ok())
        .and_then(|cookies| {
            cookies
                .split(';')
                .find_map(|cookie| cookie.trim().strip_prefix("dewbowOperator="))
        });
    let mut cookies = service.cookies.lock().unwrap();
    cookies.retain(|_, expires| *expires > Instant::now());
    token.is_some_and(|token| cookies.contains_key(token))
}
async fn api(
    State(service): State<Arc<Service>>,
    RoutePath(name): RoutePath<String>,
    headers: HeaderMap,
    input: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !operator(&service, &headers) || !origin(&service, &headers) {
        return failure(error("UNAUTHORIZED", "Open this Web with dewbow web.").into());
    }
    let Ok(Json(input)) = input else {
        return failure(error("INVALID_INPUT", "Invalid JSON request or size limit.").into());
    };
    match service.api(&name, input).await {
        Ok(result) => Json(json!({"result":result})).into_response(),
        Err(cause) => failure(cause),
    }
}
async fn internal(
    State(service): State<Arc<Service>>,
    RoutePath(name): RoutePath<String>,
    headers: HeaderMap,
) -> Response {
    if !control(&service, &headers) {
        return failure(error("UNAUTHORIZED", "Local control authentication failed.").into());
    }
    let result = match name.as_str() {
        "status" => {
            json!({"instanceId":service.instance,"pid":std::process::id(),"runtimePid":service.runtime.pid,"status":if service.stopped.load(Ordering::Relaxed){"stopping"}else{"ready"},"url":format!("http://127.0.0.1:{}",service.config.port)})
        }
        "ticket" => {
            let mut tickets = service.tickets.lock().unwrap();
            tickets.retain(|_, expires| *expires > Instant::now());
            if tickets.len() >= 128 {
                return failure(error("LIMIT_EXCEEDED", "Too many login attempts.").into());
            }
            let ticket = format!("{}{}", id(), id());
            tickets.insert(ticket.clone(), Instant::now() + Duration::from_secs(60));
            json!({"ticket":ticket})
        }
        "stop" => {
            service.shutting_down.notify_one();
            json!({"instanceId":service.instance,"status":"stopping"})
        }
        _ => return failure(error("NOT_FOUND", "Unknown local control operation.").into()),
    };
    Json(json!({"result":result})).into_response()
}
async fn login(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    if !host(&service, &headers) || !origin(&service, &headers) {
        return failure(error("UNAUTHORIZED", "Invalid login origin.").into());
    }
    let ticket = input["ticket"].as_str().unwrap_or("");
    let expires = service.tickets.lock().unwrap().remove(ticket);
    if !expires.is_some_and(|expires| expires > Instant::now()) {
        return failure(
            error(
                "UNAUTHORIZED",
                "Login link expired or was already used. Run dewbow web again.",
            )
            .into(),
        );
    }
    let cookie = format!("{}{}", id(), id());
    let mut cookies = service.cookies.lock().unwrap();
    cookies.retain(|_, expires| *expires > Instant::now());
    if cookies.len() >= 128 {
        return failure(error("LIMIT_EXCEEDED", "Too many Web sessions.").into());
    }
    cookies.insert(
        cookie.clone(),
        Instant::now() + Duration::from_secs(12 * 3600),
    );
    (
        [
            (
                header::SET_COOKIE,
                format!(
                    "dewbowOperator={cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200"
                ),
            ),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
        Json(json!({"result":{"authenticated":true}})),
    )
        .into_response()
}
async fn logout(State(service): State<Arc<Service>>, headers: HeaderMap) -> Response {
    if !origin(&service, &headers) || !operator(&service, &headers) {
        return failure(error("UNAUTHORIZED", "Authentication required.").into());
    }
    if let Some(cookie) = headers
        .get(header::COOKIE)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| {
            s.split(';')
                .find_map(|s| s.trim().strip_prefix("dewbowOperator="))
        })
    {
        service.cookies.lock().unwrap().remove(cookie);
    }
    (
        [(
            header::SET_COOKIE,
            "dewbowOperator=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        )],
        Json(json!({"result":{}})),
    )
        .into_response()
}
async fn subscribe(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    Query(mut input): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if !operator(&service, &headers) {
        return failure(error("UNAUTHORIZED", "Authentication required.").into());
    }
    let Some(sid) = input.remove("sessionId") else {
        return failure(error("INVALID_INPUT", "sessionId required.").into());
    };
    if let Err(cause) = service.summary(&sid).await {
        return failure(cause);
    }
    let native_cursor = input.remove("updateCursor");
    let cursor = match input.remove("cursor") {
        Some(value) => match value.parse::<u64>() {
            Ok(cursor) => cursor,
            Err(_) => return failure(error("INVALID_INPUT", "Invalid event cursor.").into()),
        },
        None => 0,
    };
    if !input.is_empty() {
        return failure(error("INVALID_INPUT", "Unknown subscription field.").into());
    }
    let receiver = service.changed.subscribe();
    let stream = futures::stream::unfold(
        (service, headers, sid, receiver, cursor, native_cursor, true),
        |(service, headers, sid, mut receiver, cursor, native_cursor, first)| async move {
            if service.stopped.load(Ordering::Relaxed) {
                return None;
            }
            if !first {
                tokio::select! {_ = receiver.recv()=>{},_ = tokio::time::sleep(Duration::from_secs(1))=>{}}
            }
            if !operator(&service, &headers) {
                return Some((
                    Ok::<Event, Infallible>(
                        Event::default()
                            .event("streamError")
                            .data(json!(error("UNAUTHORIZED", "Web session expired.")).to_string()),
                    ),
                    (
                        service,
                        headers,
                        sid,
                        receiver,
                        cursor,
                        native_cursor,
                        false,
                    ),
                ));
            }
            let mut query = json!({"cursor":if first {0} else {cursor}});
            if let Some(cursor) = &native_cursor {
                query["updateCursor"] = json!(cursor);
            }
            let result = async {
                let details = service.details(&sid).await?;
                let history = service.history(&sid, &query).await?;
                Ok::<_, anyhow::Error>(
                    json!({"contractVersion":"v1","instanceId":service.instance,"details":details,"history":history}),
                )
            }
            .await;
            let (event, cursor, native_cursor) = match result {
                Ok(value) => {
                    let cursor = value["history"]["nextCursor"].as_u64().unwrap_or(cursor);
                    let native = value["history"]["updateCursor"]
                        .as_str()
                        .map(str::to_string)
                        .or(native_cursor);
                    (
                        Event::default()
                            .event(if first { "snapshot" } else { "update" })
                            .data(value.to_string()),
                        cursor,
                        native,
                    )
                }
                Err(_) => (
                    Event::default().event("streamError").data(
                        json!(error(
                            "UNAVAILABLE",
                            "Conversation updates are unavailable."
                        ))
                        .to_string(),
                    ),
                    cursor,
                    native_cursor,
                ),
            };
            Some((
                Ok::<Event, Infallible>(event),
                (
                    service,
                    headers,
                    sid,
                    receiver,
                    cursor,
                    native_cursor,
                    false,
                ),
            ))
        },
    );
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}
async fn assets(State(service): State<Arc<Service>>, headers: HeaderMap, uri: Uri) -> Response {
    if !host(&service, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let name = if uri.path() == "/" {
        "index.html"
    } else {
        uri.path().trim_start_matches('/')
    };
    let Some((_, bytes)) = WEB_ASSETS.iter().find(|(path, _)| *path == name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    Response::builder().header(header::CONTENT_TYPE,mime).header(header::CACHE_CONTROL,if name=="index.html"{"no-store"}else{"public, max-age=31536000, immutable"}).header("X-Content-Type-Options","nosniff").header("Referrer-Policy","no-referrer").header("Content-Security-Policy","default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'").body(Body::from(*bytes)).unwrap()
}
pub async fn run(state: &Path) -> anyhow::Result<()> {
    config::secure_directory(state)?;
    let config = config::load(state)?;
    let lock = crate::lifecycle::DaemonLock::acquire(state)?;
    lock.recover_instance()?;
    let mut signals = crate::shutdown::Signals::register()?;
    anyhow::ensure!(
        WEB_ASSETS.iter().any(|(name, _)| *name == "index.html"),
        "Build the Web assets before compiling the daemon"
    );
    crate::service::verify_cli(&config).await?;
    let listener =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port)).await?;
    let service = Service::open(config, state).await?;
    config::write_json(
        &state.join("instance.json"),
        &json!({"instanceId":service.instance,"pid":std::process::id(),"port":service.config.port}),
    )?;
    let router = Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"status":"available"})) }),
        )
        .route("/internal/{name}", post(internal))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/api/subscribeSessionUpdates", get(subscribe))
        .route("/api/{name}", post(api))
        .fallback(assets)
        .layer(DefaultBodyLimit::max(1_048_576))
        .with_state(service.clone());
    let shutdown = service.clone();
    let shutdown_result = Arc::new(MutexResult::default());
    let outcome = shutdown_result.clone();
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            tokio::select! {_ = shutdown.shutting_down.notified()=>{},_ = signals.wait()=>{}}
            *outcome.0.lock().unwrap() = Some(
                shutdown
                    .shutdown()
                    .await
                    .map_err(|_| "Owned runtime shutdown failed".to_string()),
            );
        })
        .await;
    if let Some(Err(cause)) = shutdown_result.0.lock().unwrap().take() {
        anyhow::bail!(cause);
    }
    fs::remove_file(state.join("instance.json"))?;
    drop(lock);
    result?;
    Ok(())
}
#[derive(Default)]
struct MutexResult(std::sync::Mutex<Option<Result<(), String>>>);
