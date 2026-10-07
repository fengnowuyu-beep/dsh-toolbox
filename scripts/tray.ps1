<#
    dsh-toolbox - companion tray icon.

    DSH's own tray menu belongs to the Electron shell and cannot be extended by a
    plugin, so this companion owns a second icon next to it and offers the same
    restart / update actions. It is started by the plugin's Host half only when
    the user turns the feature on, and it exits by itself as soon as the DSH
    application process it watches is gone.

    This file is deliberately pure ASCII: Windows PowerShell 5.1 reads a script
    without a byte-order mark as ANSI, which corrupts non-ASCII source. All
    user-visible copy therefore lives in a UTF-8 JSON file read with an explicit
    -Encoding UTF8.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$AppPid,
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [string]$AppUrl = '',
    [string]$IconPath = '',
    [string]$LogFile = '',
    [string]$StringsFile = '',
    [string]$Locale = 'zh',
    [int]$PollSeconds = 3
)

$ErrorActionPreference = 'SilentlyContinue'

# ---- copy -------------------------------------------------------------------

$script:copy = @{}
if (-not [string]::IsNullOrWhiteSpace($StringsFile) -and (Test-Path -LiteralPath $StringsFile)) {
    try {
        $all = Get-Content -LiteralPath $StringsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $table = $all.$Locale
        if ($null -eq $table) { $table = $all.zh }
        if ($null -ne $table) {
            foreach ($property in $table.PSObject.Properties) { $script:copy[$property.Name] = [string]$property.Value }
        }
    } catch {
        # A missing string table only costs us the localized labels.
    }
}

function Msg {
    param([string]$Key, [string]$Fallback)
    if ($script:copy.ContainsKey($Key)) { return $script:copy[$Key] }
    return $Fallback
}

function Format2 {
    param([string]$Template, [string]$A, [string]$B)
    return ($Template -replace '\{0\}', $A) -replace '\{1\}', $B
}

function Write-TrayLog {
    param([string]$Message)
    if ([string]::IsNullOrWhiteSpace($LogFile)) { return }
    try {
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        Add-Content -LiteralPath $LogFile -Value ("{0} [tray] {1}" -f $stamp, $Message) -Encoding UTF8
    } catch { }
}

# ---- single instance per application process --------------------------------

$mutexName = "Local\dsh-toolbox-tray-$AppPid"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$owns = $false
try { $owns = $mutex.WaitOne(0) } catch { $owns = $false }
if (-not $owns) {
    Write-TrayLog 'another companion already owns this application; exiting'
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Log before touching the shell: creating a NotifyIcon talks to the notification
# area, so a busy or restarting shell must be distinguishable from a bug here.
Write-TrayLog ("starting companion pid={0} watching app pid={1} base={2}" -f $PID, $AppPid, $BaseUrl)

$script:title = Msg 'title' 'Personal toolbox'
$script:apiRoot = $BaseUrl.TrimEnd('/') + '/dsh-toolbox/api'
$script:openTarget = if ([string]::IsNullOrWhiteSpace($AppUrl)) { $BaseUrl } else { $AppUrl }

$script:notify = New-Object System.Windows.Forms.NotifyIcon
$icon = $null
if (-not [string]::IsNullOrWhiteSpace($IconPath) -and (Test-Path -LiteralPath $IconPath)) {
    try { $icon = New-Object System.Drawing.Icon($IconPath) } catch { $icon = $null }
}
if ($null -eq $icon) { $icon = [System.Drawing.SystemIcons]::Application }
$script:notify.Icon = $icon
$script:notify.Text = Msg 'tooltip' 'Personal toolbox - DeepSeek Harness'

function Invoke-ToolboxApi {
    param([string]$Method, [string]$Body = '{}', [int]$TimeoutSeconds = 25)
    $uri = "$script:apiRoot/$Method"
    return Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $Body -TimeoutSec $TimeoutSeconds
}

function Show-Balloon {
    param([string]$Text, [string]$Kind = 'Info')
    $iconKind = [System.Windows.Forms.ToolTipIcon]::Info
    if ($Kind -eq 'Warning') { $iconKind = [System.Windows.Forms.ToolTipIcon]::Warning }
    if ($Kind -eq 'Error') { $iconKind = [System.Windows.Forms.ToolTipIcon]::Error }
    try { $script:notify.ShowBalloonTip(6000, $script:title, $Text, $iconKind) } catch { }
}

function Open-Application {
    try {
        Start-Process $script:openTarget
        Write-TrayLog 'opened application'
    } catch {
        Show-Balloon (Format2 (Msg 'openFailed' 'Could not open: {0}') $_.Exception.Message '') 'Error'
    }
}

function Restart-Application {
    $body = Msg 'confirmBody' 'Restart DeepSeek Harness?'
    $answer = [System.Windows.Forms.MessageBox]::Show(
        $body,
        (Msg 'confirmTitle' 'Restart now?'),
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    try {
        $result = Invoke-ToolboxApi -Method 'restart' -Body '{"confirm":true}'
        if ($result.ok -eq $true) {
            Show-Balloon (Msg 'restarting' 'Restarting...')
            Write-TrayLog ('restart armed: {0}' -f $result.restart.detail)
        } else {
            Show-Balloon (Format2 (Msg 'restartRefused' 'Restart not started: {0}') ([string]$result.error) '') 'Error'
            Write-TrayLog ('restart refused: {0}' -f $result.error)
        }
    } catch {
        Show-Balloon (Format2 (Msg 'restartFailed' 'Restart failed: {0}') $_.Exception.Message '') 'Error'
        Write-TrayLog ("restart call failed: {0}" -f $_.Exception.Message)
    }
}

function Check-Updates {
    $script:notify.Text = Msg 'checking' 'Checking for updates...'
    try {
        $result = Invoke-ToolboxApi -Method 'update.check' -Body '{}' -TimeoutSeconds 30
        $update = $result.update
        if ($null -eq $update) {
            Show-Balloon (Msg 'noUpdateInfo' 'No update information was returned.') 'Warning'
        } elseif ($update.available -eq $true) {
            Show-Balloon (Format2 (Msg 'newVersion' 'Version {0} is available (installed {1}).') ([string]$update.latestVersion) ([string]$update.currentVersion))
        } elseif ($update.status -eq 'ok') {
            Show-Balloon (Format2 (Msg 'upToDate' 'Already up to date ({0}).') ([string]$update.currentVersion) '')
        } else {
            Show-Balloon (Format2 (Msg 'checkFailed' 'Check failed: {0}') ([string]$update.error) '') 'Warning'
        }
    } catch {
        Show-Balloon (Format2 (Msg 'checkFailed' 'Check failed: {0}') $_.Exception.Message '') 'Error'
    } finally {
        $script:notify.Text = Msg 'tooltip' 'Personal toolbox - DeepSeek Harness'
    }
}

function Close-Companion {
    param([string]$Reason = 'requested')
    Write-TrayLog ("closing companion: {0}" -f $Reason)
    try { $script:notify.Visible = $false } catch { }
    try { $script:notify.Dispose() } catch { }
    try { $mutex.ReleaseMutex() } catch { }
    [System.Windows.Forms.Application]::Exit()
}

# ---- menu -------------------------------------------------------------------

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add((Msg 'open' 'Open DeepSeek Harness')) | Out-Null
$itemRestart = $menu.Items.Add((Msg 'restart' 'Restart DeepSeek Harness'))
$itemUpdate = $menu.Items.Add((Msg 'check' 'Check for updates'))
$menu.Items.Add('-') | Out-Null
$itemClose = $menu.Items.Add((Msg 'close' 'Close this icon'))
$menu.Items[0].add_Click({ Open-Application })
$itemRestart.add_Click({ Restart-Application })
$itemUpdate.add_Click({ Check-Updates })
$itemClose.add_Click({ Close-Companion 'menu' })
$script:notify.ContextMenuStrip = $menu
$script:notify.add_MouseDoubleClick({ Open-Application })
$script:notify.Visible = $true

# Watch the application: when DSH is gone (including a plugin-armed restart),
# this companion leaves with it instead of becoming an orphaned icon.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1, $PollSeconds) * 1000
$timer.add_Tick({
    if ($null -eq (Get-Process -Id $AppPid -ErrorAction SilentlyContinue)) {
        Close-Companion 'application exited'
    }
})
$timer.Start()

Write-TrayLog ("companion started pid={0} watching app pid={1} base={2}" -f $PID, $AppPid, $BaseUrl)

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    try { $timer.Stop() } catch { }
    try { $script:notify.Dispose() } catch { }
    try { $mutex.ReleaseMutex() } catch { }
    Write-TrayLog 'companion stopped'
}
