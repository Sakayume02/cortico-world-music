$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
while ($true) {
  try {
    $rows = @()
    foreach ($s in $manager.GetSessions()) {
      $props = $null
      try { $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) } catch { }
      $info = $s.GetPlaybackInfo()
      $timeline = $null
      try { $timeline = $s.GetTimelineProperties() } catch { }
      $rows += [pscustomobject]@{
        app = $s.SourceAppUserModelId
        title = if ($props) { $props.Title } else { '' }
        artist = if ($props) { $props.Artist } else { '' }
        album = if ($props) { $props.AlbumTitle } else { '' }
        status = if ($info) { $info.PlaybackStatus.ToString() } else { '' }
        position = if ($timeline) { [double]$timeline.Position.TotalSeconds } else { 0 }
        duration = if ($timeline) { [double]$timeline.EndTime.TotalSeconds } else { 0 }
        updated = if ($s.LastUpdatedTime) { $s.LastUpdatedTime.ToString('o') } else { '' }
      }
    }
    [pscustomobject]@{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); sessions = $rows } | ConvertTo-Json -Compress -Depth 4
  } catch {
    [pscustomobject]@{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); error = $_.Exception.Message; sessions = @() } | ConvertTo-Json -Compress -Depth 4
  }
  Start-Sleep -Milliseconds 300
}
