#!/usr/bin/env nu

# Sends one RPC to the running T3 server and returns the raw reply.
def call-t3 [method: string]: nothing -> string {
    let base_dir = $env.T3CODE_HOME? | default ($env.HOME | path join .t3) | path expand
    let origin = open ($base_dir | path join userdata server-runtime.json) | get origin
    let url = $"($origin | str replace --regex '^http' 'ws')/ws?orchestrationProtocol=2"
    # T3 closes a socket when its session expires, so the TTL must outlast a full provider refresh.
    let session = ^t3 auth session issue --base-dir $base_dir --scope orchestration:read --ttl 5m --label t3-limits --json | from json
    let outcome = try {
        let reply = {
            _tag: Request
            id: "0"
            tag: $method
            payload: {}
            headers: []
        }
        | to json --raw
        | $in + "\n"
        | ^websocat --no-close --one-message --text --buffer-size 67108864 $url $"-H=Authorization: Bearer ($session.token)"
        {reply: $reply}
    } catch {|err|
        {error: $err.msg}
    }
    ^t3 auth session revoke --base-dir $base_dir $session.sessionId | ignore
    if "error" in $outcome {
        error make {msg: $outcome.error}
    }
    $outcome.reply
}

def to-window []: record -> record {
    let window = $in
    {
        id: $window.id
        label: $window.label
        usedPercent: $window.usedPercent
        remainingPercent: (100 - $window.usedPercent)
        resetsAt: ($window.resetsAt? | if $in == null { null } else { into datetime })
    }
}

def to-provider []: record -> record {
    let provider = $in
    let limits = $provider.usageLimits?
    {
        id: $provider.instanceId
        driver: $provider.driver
        label: ($provider.displayName? | default $provider.instanceId)
        enabled: $provider.enabled
        checkedAt: ($limits.checkedAt? | if $in == null { null } else { into datetime })
        status: (
            if $limits == null {
                "notReported"
            } else {
                $limits.unavailable?.reason? | default "ok"
            }
        )
        windows: ($limits.windows? | default [] | each { to-window })
    }
}

def to-rows []: record -> list<record> {
    let provider = $in
    let windows = if ($provider.windows | is-empty) {
        [
            {}
        ]
    } else {
        $provider.windows
    }
    $windows | each {|window|
        {
            provider: $provider.label
            status: $provider.status
            window: $window.label?
            "used %": $window.usedPercent?
            "remaining %": $window.remainingPercent?
            resets: $window.resetsAt?
            checked: $provider.checkedAt
        }
    }
}

# Read AI provider usage limits from the running T3 Code server.
def main [
    --json # Print JSON instead of a table
    --cached # Read T3's last snapshots instead of refreshing providers first
] {
    let method = if $cached { "server.getConfig" } else { "server.refreshProviders" }
    let reply = call-t3 $method | from json
    let providers = match $reply {
        {_tag: Exit, exit: {_tag: Success, value: {providers: $providers}}} => $providers
        _ => (
            error make {
                msg: $"T3 server did not answer ($method); is T3 Code running and are you signed in?"
            }
        )
    }
    let report = $providers | each { to-provider }
    if $json {
        $report | to json
    } else {
        $report | each { to-rows } | flatten
    }
}
