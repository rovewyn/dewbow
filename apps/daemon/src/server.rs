use crate::{config, service::Service};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, MatchedPath, Path as RoutePath, Query, RawQuery, State},
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
    collections::HashMap,
    convert::Infallible,
    fs,
    path::Path,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
include!(concat!(env!("OUT_DIR"), "/web.rs"));

const READ_ROUTES: &[(&str, &str)] = &[
    ("/api/v1/hosts", "listHosts"),
    ("/api/v1/sessions", "listSessions"),
    ("/api/v1/sessions/{sessionId}", "getSession"),
    ("/api/v1/sessions/{sessionId}/history", "readSessionHistory"),
    (
        "/api/v1/sessions/{sessionId}/activities/{itemId}",
        "getSessionActivity",
    ),
    (
        "/api/v1/sessions/{sessionId}/contents/{contentId}",
        "readSessionContent",
    ),
    ("/api/v1/operations/{commandId}", "getOperation"),
    (
        "/api/v1/hosts/{hostId}/request-receipts/{requestId}",
        "getRequestReceipt",
    ),
];
const REMOTE_READ_ROUTES: &[(&str, &str)] = &[
    ("/api/v1/networks/{networkId}/hosts/{hostId}", "listHosts"),
    (
        "/api/v1/networks/{networkId}/hosts/{hostId}/sessions",
        "listSessions",
    ),
    (
        "/api/v1/networks/{networkId}/hosts/{hostId}/sessions/{sessionId}",
        "getSession",
    ),
    (
        "/api/v1/networks/{networkId}/hosts/{hostId}/sessions/{sessionId}/history",
        "readSessionHistory",
    ),
    (
        "/api/v1/networks/{networkId}/hosts/{hostId}/sessions/{sessionId}/activities/{itemId}",
        "getSessionActivity",
    ),
    (
        "/api/v1/networks/{networkId}/hosts/{hostId}/sessions/{sessionId}/contents/{contentId}",
        "readSessionContent",
    ),
];
const MUTATION_ROUTES: &[(&str, &str)] = &[
    ("/api/v1/sessions", "createSession"),
    ("/api/v1/sessions/{sessionId}/connections", "connectSession"),
    ("/api/v1/sessions/{sessionId}/turns", "sendMessage"),
    (
        "/api/v1/sessions/{sessionId}/turns/{turnId}/instructions",
        "steerTurn",
    ),
    (
        "/api/v1/sessions/{sessionId}/turns/{turnId}/interruptions",
        "interruptTurn",
    ),
    (
        "/api/v1/sessions/{sessionId}/turns/{turnId}/interactions/{interactionId}/answers",
        "answerQuestions",
    ),
    (
        "/api/v1/sessions/{sessionId}/turns/{turnId}/interactions/{interactionId}/decisions",
        "decideApproval",
    ),
];

const NETWORK_READ_ROUTES: &[(&str, &str)] = &[
    ("/api/v1/network", "getNetwork"),
    ("/api/v1/networks/{networkId}/members", "listNetworkMembers"),
    ("/api/v1/networks/{networkId}/joins", "listNetworkJoins"),
    (
        "/api/v1/networks/{networkId}/joins/{joinAttemptId}",
        "getNetworkJoin",
    ),
];
const NETWORK_MUTATION_ROUTES: &[(&str, &str)] = &[
    ("/api/v1/networks", "createNetwork"),
    ("/api/v1/network-joins", "joinNetwork"),
    (
        "/api/v1/networks/{networkId}/invitations",
        "createInvitation",
    ),
    (
        "/api/v1/networks/{networkId}/joins/{joinAttemptId}/decisions",
        "confirmNetworkJoin",
    ),
    (
        "/api/v1/networks/{networkId}/members/{membershipId}/removals",
        "removeNetworkMember",
    ),
    (
        "/api/v1/networks/{networkId}/members/{membershipId}/contact-addresses",
        "setNetworkPeerAddress",
    ),
];

async fn network_resource(
    service: &Arc<Service>,
    name: &str,
    mut input: Value,
) -> anyhow::Result<Value> {
    let network = if matches!(name, "getNetwork" | "createNetwork" | "joinNetwork") {
        None
    } else {
        input.as_object_mut().and_then(|o| o.remove("networkId"))
    };
    if network.as_ref().is_some_and(|n| !n.is_string()) {
        return Err(error("INVALID_INPUT", "Invalid Network.").into());
    }
    service.network_lifecycle(name, &input, network.as_ref().and_then(Value::as_str)).await
        .map_err(|cause| {
            if cause.downcast_ref::<dewbow_protocol::ManagementError>().is_some() { return cause; }
            let detail = cause.to_string();
            let code = ["INVALID_INPUT", "REQUEST_CONFLICT", "SYNC_REQUIRED", "FORBIDDEN", "HISTORY_CONFLICT"]
                .into_iter().find(|code| detail.starts_with(code)).unwrap_or("UNAVAILABLE");
            error(code, "Network operation unavailable; inspect status, exact member, key and Peer settings.").into()
        })
}

pub fn failure(cause: anyhow::Error) -> Response {
    error_response(cause, false)
}
fn resource_failure(cause: anyhow::Error) -> Response {
    error_response(cause, true)
}
fn error_response(cause: anyhow::Error, resource: bool) -> Response {
    let detail = cause
        .downcast_ref::<dewbow_protocol::ManagementError>()
        .cloned()
        .or_else(|| {
            cause
                .downcast_ref::<dewbow_protocol::network::peer::PeerError>()
                .map(|e| dewbow_protocol::ManagementError {
                    code: e.code.clone(),
                    message: e.message.clone(),
                    retryable: e.retryable,
                })
        })
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
        "REQUEST_CONFLICT" | "SESSION_BUSY" | "SESSION_IN_USE" | "STALE_TURN"
        | "STALE_INTERACTION" | "RECOVERY_REQUIRED" | "SYNC_REQUIRED" | "HISTORY_CONFLICT"
            if resource =>
        {
            StatusCode::CONFLICT
        }
        "UNAVAILABLE" | "NOT_READY" if resource => StatusCode::SERVICE_UNAVAILABLE,
        "LIMIT_EXCEEDED" | "RESOURCE_LIMIT" if resource => StatusCode::TOO_MANY_REQUESTS,
        "DELIVERY_UNCERTAIN" | "EXECUTION_FAILED" if resource => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    };
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"error":detail})),
    )
        .into_response()
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
fn route_operation(path: &str, routes: &[(&str, &'static str)]) -> &'static str {
    routes
        .iter()
        .find(|(route, _)| *route == path)
        .expect("registered resource route")
        .1
}

fn resource_input(params: HashMap<String, String>, mut input: Value) -> anyhow::Result<Value> {
    let object = input
        .as_object_mut()
        .ok_or_else(|| error("INVALID_INPUT", "Input must be an object."))?;
    // Reconstruct the original domain input before validation and fingerprinting.
    // A body/query field must never replace an identity owned by the route.
    for (key, value) in params {
        anyhow::ensure!(
            !object.contains_key(&key),
            error(
                "INVALID_INPUT",
                "Path identity must not be repeated in input."
            )
        );
        object.insert(key, json!(value));
    }
    Ok(input)
}

async fn read_resource(
    State(service): State<Arc<Service>>,
    path: MatchedPath,
    RoutePath(params): RoutePath<HashMap<String, String>>,
    headers: HeaderMap,
    query: Result<Query<Vec<(String, String)>>, axum::extract::rejection::QueryRejection>,
) -> Response {
    if !operator(&service, &headers) {
        return resource_failure(error("UNAUTHORIZED", "Open this Web with dewbow web.").into());
    }
    let result = async {
        let Query(query) = query.map_err(|_| error("INVALID_INPUT", "Invalid query string."))?;
        let mut input = serde_json::Map::new();
        for (key, value) in query {
            anyhow::ensure!(
                !input.contains_key(&key),
                error("INVALID_INPUT", "Duplicate query field.")
            );
            let value = if ["cursor", "limit", "limitBytes"].contains(&key.as_str()) {
                anyhow::ensure!(
                    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()),
                    error("INVALID_INPUT", "Invalid integer query field.")
                );
                let number = value
                    .parse::<u64>()
                    .map_err(|_| error("INVALID_INPUT", "Integer query field is out of range."))?;
                let valid = match key.as_str() {
                    "limit" => (1..=500).contains(&number),
                    "limitBytes" => (4..=262144).contains(&number),
                    _ => true,
                };
                anyhow::ensure!(valid, error("INVALID_INPUT", "Page limit is out of range."));
                json!(number)
            } else {
                json!(value)
            };
            input.insert(key, value);
        }
        let input = resource_input(params, Value::Object(input))?;
        if NETWORK_READ_ROUTES.iter().any(|(p, _)| *p == path.as_str()) {
            network_resource(
                &service,
                route_operation(path.as_str(), NETWORK_READ_ROUTES),
                input,
            )
            .await
        } else if path.as_str().starts_with("/api/v1/networks/") {
            crate::remote::read(
                &service,
                route_operation(path.as_str(), REMOTE_READ_ROUTES),
                input,
            )
            .await
        } else {
            service
                .api(route_operation(path.as_str(), READ_ROUTES), input)
                .await
        }
    }
    .await;
    match result {
        Ok(result) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({"result":result})),
        )
            .into_response(),
        Err(cause) => resource_failure(cause),
    }
}

async fn mutate_resource(
    State(service): State<Arc<Service>>,
    path: MatchedPath,
    RoutePath(params): RoutePath<HashMap<String, String>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    input: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !operator(&service, &headers) || !origin(&service, &headers) {
        return resource_failure(error("UNAUTHORIZED", "Open this Web with dewbow web.").into());
    }
    let Ok(Json(input)) = input else {
        return resource_failure(
            error("INVALID_INPUT", "Invalid JSON request or size limit.").into(),
        );
    };
    if query.is_some() {
        return resource_failure(
            error("INVALID_INPUT", "Mutation query fields are not supported.").into(),
        );
    }
    let mut input = match resource_input(params, input) {
        Ok(input) => input,
        Err(cause) => return resource_failure(cause),
    };
    if NETWORK_MUTATION_ROUTES
        .iter()
        .any(|(p, _)| *p == path.as_str())
    {
        return match network_resource(
            &service,
            route_operation(path.as_str(), NETWORK_MUTATION_ROUTES),
            input,
        )
        .await
        {
            Ok(result) => (
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({"result":result})),
            )
                .into_response(),
            Err(cause) => resource_failure(cause),
        };
    }
    let suffix = path
        .as_str()
        .strip_prefix("/api/v1/networks/{networkId}/hosts/{hostId}");
    let operation_path = suffix.map(|s| format!("/api/v1{s}"));
    let name = route_operation(
        operation_path.as_deref().unwrap_or(path.as_str()),
        MUTATION_ROUTES,
    );
    let network = if suffix.is_some() {
        input.as_object_mut().unwrap().remove("networkId")
    } else {
        None
    };
    let remote = input
        .get("hostId")
        .and_then(Value::as_str)
        .filter(|host| *host != service.config.host_id)
        .map(str::to_owned);
    let request_id = input["requestId"].as_str().unwrap_or("").to_owned();
    let result = if let Some(network) = network {
        match network
            .as_str()
            .and_then(|n| dewbow_protocol::network::NetworkId::parse(n).ok())
        {
            Some(network) => {
                service
                    .remote_operation_in(name, input, Some(network))
                    .await
            }
            None => Err(error("INVALID_INPUT", "Invalid Network.").into()),
        }
    } else {
        service.api(name, input).await
    };
    match result {
        Ok(result) => {
            let status = match result["status"].as_str() {
                Some("accepted") => StatusCode::ACCEPTED,
                Some("delivered") if matches!(name, "createSession" | "sendMessage") => {
                    StatusCode::CREATED
                }
                _ => StatusCode::OK,
            };
            let location =
                if let Some(target) = remote {
                    let network =
                        match service.store.network.outbound_network_for_command(
                            result["commandId"].as_str().unwrap_or(""),
                        ) {
                            Ok(Some(network)) => network,
                            _ => return resource_failure(
                                error(
                                    "DELIVERY_UNCERTAIN",
                                    "Retain the original request identity for receipt recovery.",
                                )
                                .into(),
                            ),
                        };
                    // URI query encoding also escapes request IDs when used as path segments.
                    fn segment(value: &str) -> String {
                        value
                            .bytes()
                            .map(|b| {
                                if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                                    (b as char).to_string()
                                } else {
                                    format!("%{b:02X}")
                                }
                            })
                            .collect()
                    }
                    format!(
                        "/api/v1/hosts/{}/request-receipts/{}?networkId={}&sourceHostId={}",
                        segment(&target),
                        segment(&request_id),
                        network,
                        segment(&service.config.host_id)
                    )
                } else {
                    format!(
                        "/api/v1/operations/{}",
                        result["commandId"].as_str().unwrap()
                    )
                };
            (
                status,
                [
                    (header::CACHE_CONTROL, "no-store"),
                    (header::LOCATION, location.as_str()),
                ],
                Json(json!({"result":result})),
            )
                .into_response()
        }
        Err(cause) => resource_failure(cause),
    }
}
async fn internal(
    State(service): State<Arc<Service>>,
    RoutePath(name): RoutePath<String>,
    headers: HeaderMap,
    input: Option<Json<Value>>,
) -> Response {
    if !control(&service, &headers) {
        return failure(error("UNAUTHORIZED", "Local control authentication failed.").into());
    }
    let result = match name.as_str() {
        "createNetwork"
        | "createInvitation"
        | "joinNetwork"
        | "getNetworkJoin"
        | "listNetworkJoins"
        | "confirmNetworkJoin"
        | "getNetwork"
        | "listNetworkMembers"
        | "removeNetworkMember"
        | "leaveNetwork"
        | "setNetworkPeerAddress" => {
            match service
                .network_control(&name, &input.map(|v| v.0).unwrap_or(Value::Null))
                .await
            {
                Ok(result) => result,
                Err(cause) => {
                    let text = cause.to_string();
                    let code = [
                        "INVALID_INPUT",
                        "REQUEST_CONFLICT",
                        "SYNC_REQUIRED",
                        "FORBIDDEN",
                        "UNAVAILABLE",
                    ]
                    .into_iter()
                    .find(|c| text.starts_with(c))
                    .unwrap_or("UNAVAILABLE");
                    let message = match code {
                        "INVALID_INPUT" => {
                            "Invalid Network input or stale confirmation; check endpoints, attempt and public key."
                        }
                        "REQUEST_CONFLICT" => "Request ID was already used with different input.",
                        "FORBIDDEN" => "The selected membership cannot perform this operation.",
                        "SYNC_REQUIRED" => {
                            "Membership context changed; inspect status and retry the original request."
                        }
                        _ => {
                            "Network operation unavailable; inspect membership status and Peer listener settings."
                        }
                    };
                    return failure(error(code, message).into());
                }
            }
        }
        "status" => {
            json!({"instanceId":service.instance,"pid":std::process::id(),"runtimePid":service.runtime.pid,"version":env!("CARGO_PKG_VERSION"),"upgradeProtocol":"v1","maintenance":service.maintenance.active(),"status":if service.stopped.load(Ordering::Relaxed){"stopping"}else{"ready"},"url":format!("http://127.0.0.1:{}",service.config.port)})
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
        _ => match service
            .upgrade_control(&name, &input.map(|v| v.0).unwrap_or(Value::Null))
            .await
        {
            Ok(value) => value,
            Err(cause) => return failure(cause),
        },
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
    RoutePath(sid): RoutePath<String>,
    headers: HeaderMap,
    query: Result<Query<Vec<(String, String)>>, axum::extract::rejection::QueryRejection>,
) -> Response {
    if !operator(&service, &headers) {
        return resource_failure(error("UNAUTHORIZED", "Authentication required.").into());
    }
    let Ok(Query(query)) = query else {
        return resource_failure(error("INVALID_INPUT", "Invalid query string.").into());
    };
    let mut input = HashMap::new();
    for (key, value) in query {
        if input.insert(key, value).is_some() {
            return resource_failure(error("INVALID_INPUT", "Duplicate query field.").into());
        }
    }
    if let Err(cause) = service.summary(&sid).await {
        return resource_failure(cause);
    }
    let native_cursor = input.remove("updateCursor");
    let cursor = match input.remove("cursor") {
        Some(value) => match value.parse::<u64>() {
            Ok(cursor) => cursor,
            Err(_) => {
                return resource_failure(error("INVALID_INPUT", "Invalid event cursor.").into());
            }
        },
        None => 0,
    };
    if !input.is_empty() {
        return resource_failure(error("INVALID_INPUT", "Unknown subscription field.").into());
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
            let result = service
                .updates(
                    &sid,
                    if first { 0 } else { cursor },
                    native_cursor.as_deref(),
                )
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
    (
        [(header::CACHE_CONTROL, "no-store")],
        Sse::new(stream).keep_alive(KeepAlive::default()),
    )
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

async fn subscribe_remote(
    State(service): State<Arc<Service>>,
    RoutePath(params): RoutePath<HashMap<String, String>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if !operator(&service, &headers) {
        return resource_failure(error("UNAUTHORIZED", "Authentication required.").into());
    }
    if query.is_some() || headers.contains_key("last-event-id") {
        return resource_failure(
            error(
                "INVALID_INPUT",
                "Remote subscriptions start with a fresh snapshot.",
            )
            .into(),
        );
    }
    let input = json!(params);
    let remote = match crate::remote::subscribe(&service, input).await {
        Ok(remote) => remote,
        Err(cause) => return resource_failure(cause),
    };
    let stream = futures::stream::unfold(
        (service, headers, remote, false),
        |(service, headers, mut remote, failed)| async move {
            if failed {
                return None;
            }
            let result = loop {
                if !operator(&service, &headers) {
                    break Err(error("UNAUTHORIZED", "Web session expired."));
                }
                if service.stopped.load(Ordering::Acquire) {
                    return None;
                }
                match tokio::time::timeout(Duration::from_secs(1), remote.next()).await {
                    Err(_) => continue,
                    Ok(result) => {
                        break result.map_err(|cause| dewbow_protocol::ManagementError {
                            code: cause.code,
                            message: cause.message,
                            retryable: cause.retryable,
                        });
                    }
                }
            };
            let failed = result.is_err();
            let event = match result {
                Ok((kind, value)) => Event::default().event(kind).data(value.to_string()),
                Err(cause) => Event::default()
                    .event("streamError")
                    .data(json!(cause).to_string()),
            };
            Some((
                Ok::<_, Infallible>(event),
                (service, headers, remote, failed),
            ))
        },
    );
    (
        [(header::CACHE_CONTROL, "no-store")],
        Sse::new(stream).keep_alive(KeepAlive::default()),
    )
        .into_response()
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
    let mut router = Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"status":"available"})) }),
        )
        .route("/internal/{name}", post(internal))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/api/v1/sessions/{sessionId}/updates", get(subscribe));
    router = router.route(
        "/api/v1/networks/{networkId}/hosts/{hostId}/sessions/{sessionId}/updates",
        get(subscribe_remote),
    );
    for &(path, _) in READ_ROUTES {
        router = router.route(path, get(read_resource));
    }
    for &(path, _) in REMOTE_READ_ROUTES {
        router = router.route(path, get(read_resource));
    }
    for &(path, _) in MUTATION_ROUTES {
        router = router.route(path, post(mutate_resource));
        let suffix = path.strip_prefix("/api/v1").unwrap();
        router = router.route(
            &format!("/api/v1/networks/{{networkId}}/hosts/{{hostId}}{suffix}"),
            post(mutate_resource),
        );
    }
    for &(path, _) in NETWORK_READ_ROUTES {
        router = router.route(path, get(read_resource));
    }
    for &(path, _) in NETWORK_MUTATION_ROUTES {
        router = router.route(path, post(mutate_resource));
    }
    let router = router
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
