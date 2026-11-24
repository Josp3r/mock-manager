# Pure PowerShell/C# input-contract test. No native read or write method is called.
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot '../../src/native/windows-system-proxy.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Native helper must parse before contract testing' }
$definition = $ast.Find({ param($node)
  $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Add-Type'
}, $true)
$parser = $ast.Find({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Parse-State'
}, $true)
if ($null -eq $definition -or $null -eq $parser) { throw 'Native helper input contract was not found' }
# Execute the production C# types and production parser in isolation; importing
# the entire helper would execute its system-preference command.
Add-Type -TypeDefinition $definition.CommandElements[2].Value
. ([scriptblock]::Create($parser.Extent.Text))

foreach ($text in @($null, '', ('Unicode ' + [char]0x4e2d + [char]0x6587 + ' % #'))) {
  $json = @{
    enabled = $true
    configuration = @{
      flags = 1; proxyServer = $text; proxyBypass = $text; autoConfigURL = $text; autoDiscoveryFlags = 32
    }
  } | ConvertTo-Json -Depth 8 -Compress
  $parsed = Parse-State ($json | ConvertFrom-Json)
  foreach ($name in @('proxyServer', 'proxyBypass', 'autoConfigURL')) {
    if (-not [object]::Equals($parsed.$name, $text)) { throw "Input conversion changed null/empty/Unicode string in $name" }
  }
  if ($parsed.flags -ne 1 -or $parsed.autoDiscoveryFlags -ne 32) { throw 'Input conversion changed numeric flags' }
}
[Console]::Out.Write('Windows native null, empty and Unicode input contracts passed')
