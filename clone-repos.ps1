# clone-repos.ps1
# Clones all 70 prediction-market reference repos (shallow --depth=1) into ./repos/
# Safe to re-run: already-cloned repos are skipped.

$reposDir = Join-Path $PSScriptRoot "repos"
New-Item -ItemType Directory -Force -Path $reposDir | Out-Null

$repos = @(
    # ── Official Polymarket ──────────────────────────────────────────────
    "Polymarket/agents",
    "Polymarket/py-clob-client",
    "Polymarket/polymarket-subgraph",
    "Polymarket/clob-client",
    "Polymarket/poly-market-maker",
    "Polymarket/rs-clob-client",
    "Polymarket/python-order-utils",
    "Polymarket/clob-order-utils",
    "Polymarket/ctf-exchange",
    "Polymarket/uma-ctf-adapter",

    # ── Community SDKs ───────────────────────────────────────────────────
    "cyl19970726/poly-sdk",

    # ── Market Making ────────────────────────────────────────────────────
    "lorine93s/Polymarket-bot",
    "warproxxx/poly-maker",
    "0xMel/polymarket-marketmaking",

    # ── Copy Trading ─────────────────────────────────────────────────────
    "Drakkar-Software/OctoBot-Prediction-Market",
    "Orbital-Alpha/polymarket-copy-trading-bot",
    "MrFadiAi/Polymarket-bot",
    "gamma-trade-lab/polymarket-copy-trading-bot",
    "GiordanoSouza/polymarket-copy-trading-bot",
    "samanalalokaya/polymarket-copy-trading-bot",
    "echandsome/Polymarket-betting-bot",

    # ── AI Agents ────────────────────────────────────────────────────────
    "caiovicentino/polymarket-mcp-server",

    # ── Arbitrage & HFT ──────────────────────────────────────────────────
    "Trust412/Polymarket-spike-bot-v1",
    "ent0n29/polybot",
    "Trum3it/polymarket-arbitrage-bot",
    "0xalberto/polymarket-arbitrage-bot",
    "aulekator/Polymarket-BTC-15-Minute-Trading-Bot",
    "TradeSEB/Polymarket-Trading-Bot-Gabagool",

    # ── Kalshi Community SDKs ────────────────────────────────────────────
    "ArshKA/kalshi-client",
    "humz2k/kalshi-python-unofficial",
    "AndrewNolte/KalshiPythonClient",
    "arvchahal/kalshi-rs",
    "pbeets/kalshi-trade-rs",
    "rmadev01/kalshi-rs",

    # ── Kalshi AI Bots ───────────────────────────────────────────────────
    "ryanfrigo/kalshi-ai-trading-bot",
    "OctagonAI/kalshi-deep-trading-bot",
    "yllvar/Kalshi-Quant-TeleBot",
    "ajwann/kalshi-genai-trading-bot",

    # ── Cross-Platform ───────────────────────────────────────────────────
    "Jon-Becker/prediction-market-analysis",
    "pmxt-dev/pmxt",
    "CarlosIbCu/polymarket-kalshi-btc-arbitrage-bot",
    "TopTrenDev/polymarket-kalshi-arbitrage-bot",
    "gtg7784/dr-manhattan-rust",
    "taetaehoho/poly-kalshi-arb",
    "warproxxx/poly_data",

    # ── Research & Analytics ─────────────────────────────────────────────
    "PaulieB14/polymarket-subgraph-analytics",

    # ── Manifold Markets ─────────────────────────────────────────────────
    "manifoldmarkets/manifold",
    "manifoldmarkets/manifold-api",

    # ── Sports Trading ───────────────────────────────────────────────────
    "rustyneuron01/Polymarket-Sports-Trading-Bot",
    "frogansol/polymarket-arbitrage-trading-bot-sports-crypto",
    "CrewSX/Polymarket-Sports-Arbitrage-Bot",
    "sarviinageelen/polymarket-sports-analysis",
    "PolyScripts/polymarket-sports-betting-trading-bot-py",
    "llSourcell/Poly-Trader",

    # ── Weather Trading ──────────────────────────────────────────────────
    "erickdronski/kalshi-polymarket-trader",

    # ── Election Forecasting ─────────────────────────────────────────────
    "jseabold/538model",
    "arbbets/Prediction-Markets-Data",

    # ── Awesome Lists ────────────────────────────────────────────────────
    "harish-garg/Awesome-Polymarket-Tools",
    "aarora4/Awesome-Prediction-Market-Tools"
)

$total  = $repos.Count
$done   = 0
$failed = @()

foreach ($repo in $repos) {
    $done++
    $name   = $repo.Split("/")[1]
    $target = Join-Path $reposDir $name

    # Skip if already cloned
    if (Test-Path (Join-Path $target ".git")) {
        Write-Host "[$done/$total] SKIP  $repo (already cloned)"
        continue
    }

    $url = "https://github.com/$repo.git"
    Write-Host "[$done/$total] CLONE $repo ..." -NoNewline

    # manifoldmarkets/manifold is a huge monorepo — use blobless filter
    if ($repo -like "manifoldmarkets/manifold*") {
        git clone --depth=1 --filter=blob:none --quiet $url $target 2>&1 | Out-Null
    } else {
        git clone --depth=1 --quiet $url $target 2>&1 | Out-Null
    }

    if ($LASTEXITCODE -eq 0) {
        Write-Host " OK"
    } else {
        Write-Host " FAILED (404 or private)"
        $failed += $repo
        # Clean up empty dir if git left one
        if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    }
}

Write-Host ""
Write-Host "=== Done: $($total - $failed.Count)/$total cloned ==="
if ($failed.Count -gt 0) {
    Write-Host "Failed repos:"
    $failed | ForEach-Object { Write-Host "  - $_" }
}
