#!/usr/bin/env nu

# Asks the running T3 server for its config once and returns the raw RPC reply.
def fetch-config []: nothing -> string {
    let base_dir = $env.HOME | path join .t3
    let origin = open ($base_dir | path join userdata server-runtime.json) | get origin
    let url = $"($origin | str replace --regex '^http' 'ws')/ws?orchestrationProtocol=2"
    let token = ^t3 auth session issue --base-dir $base_dir --scope orchestration:read --ttl 1m --label t3-limits --token-only | str trim
    {
        _tag: Request
        id: "0"
        tag: server.getConfig
        payload: {}
        headers: []
    }
    | to json --raw
    | $in + "\n"
    | ^websocat --no-close --one-message --text --buffer-size 67108864 $url $"-H=Authorization: Bearer ($token)"
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
] {
    let reply = fetch-config | from json
    let config = match $reply {
        {_tag: Exit, exit: {_tag: Success, value: $value}} => $value
        _ => (
            error make {
                msg: "T3 server did not return its config; is T3 Code running and are you signed in?"
            }
        )
    }
    let report = $config.providers | each { to-provider }
    if $json {
        $report | to json
    } else {
        $report | each { to-rows } | flatten
    }
}
