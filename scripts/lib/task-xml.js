/*
 * Builds the Windows Task Scheduler XML for the daily backup task, for
 * `schtasks /Create /XML`. The simple `/SC DAILY /ST` form of schtasks has
 * no switch for "run as soon as possible after a missed start" - that's
 * Settings/StartWhenAvailable, only reachable through the full task
 * definition, so this writes the XML directly instead.
 */
function escapeXml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// startTime: "HH:MM". startDate: "YYYY-MM-DD", the trigger's anchor date -
// with DaysInterval 1 it then fires at that time every day from then on.
function buildDailyTaskXml({ description, startTime, startDate, command, args, workingDirectory }) {
    const argsLine = args.map((a) => `"${escapeXml(a)}"`).join(' ');
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${startDate}T${startTime}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${argsLine}</Arguments>
      <WorkingDirectory>${escapeXml(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

module.exports = { buildDailyTaskXml, escapeXml };
