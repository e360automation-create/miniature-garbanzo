use serde::{Deserialize, Serialize};
use std::io::{self, BufRead};

#[derive(Debug, Deserialize, Serialize)]
struct Request {
    task: String,
    #[serde(default)]
    requires_network: bool,
}

#[derive(Debug, Serialize)]
struct Decision {
    accepted: bool,
    network_allowed: bool,
    message: String,
}

fn evaluate(request: Request) -> Decision {
    if request.task.trim().is_empty() {
        return Decision { accepted: false, network_allowed: false, message: "Task must not be empty".into() };
    }
    // Rust core defaults to local-only. Network access is a policy decision, never implicit.
    Decision {
        accepted: true,
        network_allowed: false,
        message: if request.requires_network {
            "Network requested; blocked by local-only policy. Escalation must be separately approved in the TypeScript agent.".into()
        } else {
            "Accepted for local processing.".into()
        },
    }
}

fn main() {
    eprintln!("agent-core ready; newline-delimited JSON on stdin, decisions on stdout");
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let output = match serde_json::from_str::<Request>(&line) {
            Ok(request) => serde_json::to_string(&evaluate(request)).unwrap_or_else(|_| "{}".into()),
            Err(error) => serde_json::json!({"accepted":false,"network_allowed":false,"message":format!("Invalid request: {error}")}).to_string(),
        };
        println!("{output}");
    }
}
