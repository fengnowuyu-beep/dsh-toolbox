<#
    dsh-toolbox - companion tray icon.

    DSH's own tray menu belongs to the Electron shell and cannot be extended by a
    plugin, so this companion owns a second icon next to it and offers the same
    restart / update actions, plus showing or hiding the DSH window itself. It is
    started by the plugin's Host half only when the user turns the feature on, and
    it exits by itself as soon as the DSH application process it watches is gone.

    Showing and hiding the window happens HERE, in this process, rather than
    through the Host: Windows only lets a process move another application's
    window to the front when it owns the foreground, and a click on this icon is
    what grants that. Asking the Host to do it would show the window without
    raising it.

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
try {
    $owns = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    # The previous companion was killed rather than closed - which is exactly what
    # turning the settings switch off does - so the mutex is abandoned and .NET
    # reports it as an exception even though this process now owns it. Treating
    # that as "someone else is running" is what would keep the icon from ever
    # coming back.
    $owns = $true
} catch {
    $owns = $false
}
if (-not $owns) {
    Write-TrayLog 'another companion already owns this application; exiting'
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# The window code is shared with the maximize helper and defines functions only,
# so dot-sourcing it here keeps the foreground rights of this process's click.
. (Join-Path $PSScriptRoot 'appwindow.ps1')

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

<#
    Show the DSH window if it is hidden or minimized, hide it if it is on screen.
    Falls back to opening the application when the process has no window at all
    (a `dsh web`-style launch, or a window that has not been created yet).
#>
function Toggle-ApplicationWindow {
    try {
        $action = Invoke-AppWindowToggle -ProcessId $AppPid
        switch ($action) {
            'shown' { Write-TrayLog ('showed the application window (app pid {0})' -f $AppPid) }
            'hidden' { Write-TrayLog ('hid the application window (app pid {0})' -f $AppPid) }
            default {
                Write-TrayLog ('no window to toggle for app pid {0}; opening instead' -f $AppPid)
                Open-Application
            }
        }
    } catch {
        Show-Balloon (Format2 (Msg 'toggleFailed' 'Could not show the window: {0}') $_.Exception.Message '') 'Error'
        Write-TrayLog ("toggle failed: {0}" -f $_.Exception.Message)
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

# Closing DSH cannot be undone by the plugin, and the shell owns app.quit(): the
# plugin's only lever is ending the application process, which the Node half turns
# into its own graceful shutdown. So this always asks first and says plainly that
# work in progress is interrupted.
function Stop-Application {
    $answer = [System.Windows.Forms.MessageBox]::Show(
        (Msg 'quitConfirmBody' 'Close DeepSeek Harness?'),
        (Msg 'quitConfirmTitle' 'Close DeepSeek Harness?'),
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning)
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    try {
        $result = Invoke-ToolboxApi -Method 'quit' -Body '{"confirm":true}'
        if ($result.ok -eq $true) {
            Show-Balloon (Msg 'closing' 'Closing DeepSeek Harness...')
            Write-TrayLog ('quit armed: {0}' -f $result.quit.detail)
        } else {
            Show-Balloon (Format2 (Msg 'quitRefused' 'Close not started: {0}') ([string]$result.error) '') 'Error'
            Write-TrayLog ('quit refused: {0}' -f $result.error)
        }
    } catch {
        Show-Balloon (Format2 (Msg 'quitFailed' 'Close failed: {0}') $_.Exception.Message '') 'Error'
        Write-TrayLog ("quit call failed: {0}" -f $_.Exception.Message)
    }
}

# The settings panel belongs to the page, so this only asks: the Host pushes the
# request down the page's own event stream and the page opens the shell's panel.
# The window is deliberately left alone - showing it here made the action feel
# heavy - and with no page listening the request simply has no effect.
function Open-Settings {
    try {
        $result = Invoke-ToolboxApi -Method 'page.request' -Body '{"action":"settings"}'
        $delivered = 0
        if ($null -ne $result.delivered) { $delivered = [int]$result.delivered }
        Write-TrayLog ('asked {0} page(s) to open settings' -f $delivered)
    } catch {
        Show-Balloon (Format2 (Msg 'settingsFailed' 'Could not open settings: {0}') $_.Exception.Message '') 'Error'
        Write-TrayLog ("settings request failed: {0}" -f $_.Exception.Message)
    }
}

# ---- menu -------------------------------------------------------------------

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemToggle = $menu.Items.Add((Msg 'toggle' 'Show / hide DeepSeek Harness'))
$itemRestart = $menu.Items.Add((Msg 'restart' 'Restart DeepSeek Harness'))
$itemUpdate = $menu.Items.Add((Msg 'check' 'Check for updates'))
$itemSettings = $menu.Items.Add((Msg 'settings' 'Settings'))
$itemQuit = $menu.Items.Add((Msg 'quit' 'Close DeepSeek Harness'))
$itemToggle.add_Click({ Toggle-ApplicationWindow })
$itemRestart.add_Click({ Restart-Application })
$itemUpdate.add_Click({ Check-Updates })
$itemSettings.add_Click({ Open-Settings })
$itemQuit.add_Click({ Stop-Application })
$script:notify.ContextMenuStrip = $menu
$script:notify.add_MouseDoubleClick({ Toggle-ApplicationWindow })
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
