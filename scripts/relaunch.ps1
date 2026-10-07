<#
    dsh-toolbox - detached relaunch helper.

    Started by the plugin's Host half *before* DSH is asked to exit, so the
    application is only ever stopped while a live relauncher is already waiting
    for it. The helper outlives DSH because it is spawned detached.

    Sequence:
      1. write the readiness marker (the Host refuses the restart without it),
      2. wait for the Desktop application process to disappear,
      3. wait for the HTTP port to be free (DSH's Node half may still be
         flushing session logs after the application process is gone),
      4. start the very same executable again.

    Every step is logged to -LogFile so a restart that did not happen can be
    explained after the fact.

    Pure ASCII by construction: Windows PowerShell 5.1 reads a script without a
    byte-order mark as ANSI, so any non-ASCII literal here would be misread.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$WaitPid,
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$ReadyFile,
    [int]$Port = 0,
    [int]$WaitSeconds = 60,
    [int]$PortWaitSeconds = 45,
    [string]$LogFile = ''
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-HelperLog {
    param([string]$Message)
    if ([string]::IsNullOrWhiteSpace($LogFile)) { return }
    try {
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        Add-Content -LiteralPath $LogFile -Value ("{0} [relaunch] {1}" -f $stamp, $Message) -Encoding UTF8
    } catch {
        # Logging must never stop a restart.
    }
}

function Test-PortBusy {
    param([int]$Target)
    if ($Target -le 0) { return $false }
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connect = $client.BeginConnect('127.0.0.1', $Target, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($connect)
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

<#
    Process ids listening on one port, from Get-NetTCPConnection when that module
    is present and from netstat otherwise.
#>
function Get-PortOwners {
    param([int]$Target)
    if ($Target -le 0) { return @() }
    $owners = @()
    $connections = Get-NetTCPConnection -LocalPort $Target -State Listen -ErrorAction SilentlyContinue
    if ($null -ne $connections) {
        foreach ($connection in $connections) {
            if ($null -ne $connection.OwningProcess -and $connection.OwningProcess -gt 0) { $owners += [int]$connection.OwningProcess }
        }
    } else {
        $lines = & netstat.exe -ano -p tcp 2>$null
        foreach ($line in $lines) {
            if ($line -notmatch ':(\d+)\s+\S+\s+LISTENING\s+(\d+)') { continue }
            if ([int]$Matches[1] -ne $Target) { continue }
            $owners += [int]$Matches[2]
        }
    }
    return ($owners | Sort-Object -Unique)
}

<#
    Whether anything is still listening on one port.

    The listener table is the authoritative signal, and the connect probe is only
    a cross-check: a bound listener whose accept backlog is full refuses
    connections, so a probe alone can report a busy port as free. The two are
    combined in the safe direction - a port counts as free only when no owner is
    listed AND a connect is refused.
#>
function Test-PortListening {
    param([int]$Target)
    if ($Target -le 0) { return $false }
    $owners = @(Get-PortOwners -Target $Target)
    if ($owners.Count -gt 0) { return $true }
    return (Test-PortBusy -Target $Target)
}

<#
    After the application process is gone, its Node half may still be flushing
    session logs while holding the HTTP port. Left alone that would make the fresh
    instance refuse to start ("another DSH instance is running"). Only a process
    running the very same executable as the one being relaunched is eligible, so
    an unrelated listener on that port is never touched.
#>
function Clear-StaleInstance {
    param([int]$Target, [string]$OwnProcessName, [int]$Attempts = 20)
    if ($Target -le 0 -or [string]::IsNullOrWhiteSpace($OwnProcessName)) { return }
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        if (-not (Test-PortListening -Target $Target)) { return }
        $owners = @(Get-PortOwners -Target $Target)
        if ($owners.Count -eq 0) { return }
        foreach ($owner in $owners) {
            $candidate = Get-Process -Id $owner -ErrorAction SilentlyContinue
            if ($null -eq $candidate) { continue }
            if ($candidate.ProcessName -ne $OwnProcessName) {
                Write-HelperLog ("port {0} is held by unrelated process {1} ({2}); leaving it alone" -f $Target, $owner, $candidate.ProcessName)
                return
            }
            Write-HelperLog ("stopping stale instance pid={0} ({1}) holding port {2}" -f $owner, $candidate.ProcessName, $Target)
            Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 300
    }
}

# Step 1 - announce readiness. The marker is the Host's proof that stopping the
# application will be followed by a relaunch.
try {
    $markerDirectory = Split-Path -Path $ReadyFile -Parent
    if (-not [string]::IsNullOrWhiteSpace($markerDirectory) -and -not (Test-Path -LiteralPath $markerDirectory)) {
        New-Item -ItemType Directory -Force -Path $markerDirectory | Out-Null
    }
    Set-Content -LiteralPath $ReadyFile -Value $PID -Encoding ASCII -Force
    Write-HelperLog ("ready pid={0} waiting for app pid={1} exe={2} port={3}" -f $PID, $WaitPid, $ExePath, $Port)
} catch {
    Write-HelperLog ("could not write readiness marker: {0}" -f $_.Exception.Message)
    exit 1
}

# Step 2 - wait for the application process to exit.
$deadline = (Get-Date).AddSeconds([Math]::Max(5, $WaitSeconds))
while ((Get-Date) -lt $deadline) {
    $alive = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
    if ($null -eq $alive) { break }
    Start-Sleep -Milliseconds 200
}
Write-HelperLog 'application process is gone'

# Step 3 - wait until the port is released, then clean up a stale instance of the
# same executable only if it is still holding it. The log states which of the two
# actually happened, so a restart that could not start says so.
if ($Port -gt 0) {
    $portDeadline = (Get-Date).AddSeconds([Math]::Max(1, $PortWaitSeconds))
    while ((Get-Date) -lt $portDeadline) {
        if (-not (Test-PortListening -Target $Port)) { break }
        Start-Sleep -Milliseconds 300
    }
    if (-not (Test-PortListening -Target $Port)) {
        Write-HelperLog ("port {0} released" -f $Port)
    } else {
        Write-HelperLog ("port {0} still listening after {1}s; checking for a stale instance" -f $Port, $PortWaitSeconds)
        $ownProcessName = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)
        Clear-StaleInstance -Target $Port -OwnProcessName $ownProcessName
        if (Test-PortListening -Target $Port) {
            Write-HelperLog ("port {0} is still listening; the new instance may refuse to start" -f $Port)
        } else {
            Write-HelperLog ("port {0} released after cleanup" -f $Port)
        }
    }
}

# A short settle before the new instance grabs the single-instance lock and the
# port; racing the dying process would surface as "another DSH instance".
Start-Sleep -Milliseconds 700

# Step 4 - start the same executable again.
try {
    $workingDirectory = Split-Path -Path $ExePath -Parent
    if ([string]::IsNullOrWhiteSpace($workingDirectory)) { $workingDirectory = $null }
    Start-Process -FilePath $ExePath -WorkingDirectory $workingDirectory
    Write-HelperLog ('relaunched {0}' -f $ExePath)
} catch {
    Write-HelperLog ("relaunch failed: {0}" -f $_.Exception.Message)
}

try { Remove-Item -LiteralPath $ReadyFile -Force } catch { }
