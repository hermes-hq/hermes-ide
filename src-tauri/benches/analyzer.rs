//! Benchmarks for the PTY output analyzer — the hottest path in the app.
//!
//! Run with: cargo bench --manifest-path src-tauri/Cargo.toml --bench analyzer
//!
//! These benchmarks exercise:
//! - `process()`: ANSI stripping, line parsing, pattern matching (runs on every 4KB PTY chunk)
//! - `to_metrics()`: deep clone of accumulated state (runs every 5s + on phase changes)
//! - Eviction paths: VecDeque front-removal for files_touched / memory_facts at capacity

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use hermes_ide_lib::pty::analyzer::OutputAnalyzer;

/// Realistic 4KB chunk of ANSI-heavy terminal output (Claude Code style).
fn ansi_heavy_chunk() -> Vec<u8> {
    let mut buf = Vec::with_capacity(4096);
    for i in 0..60 {
        // Simulate colored output lines with cursor positioning
        let line = format!(
            "\x1b[38;5;{}m  {} │ \x1b[0m some code here: let x = {};\x1b[K\r\n",
            30 + (i % 8),
            100 + i,
            i * 42,
        );
        buf.extend_from_slice(line.as_bytes());
    }
    // Pad to ~4KB
    while buf.len() < 4000 {
        buf.extend_from_slice(b"\x1b[0m \x1b[K\r\n");
    }
    buf.truncate(4096);
    buf
}

/// Realistic agent output with tool calls and file paths.
fn agent_output_chunk() -> Vec<u8> {
    let lines = [
        "\x1b[1;36m⏺ \x1b[0mI'll read the file to understand the current implementation.\r\n",
        "\x1b[2m  Tool: Read src/components/App.tsx\x1b[0m\r\n",
        "\x1b[2m  Duration: 0.3s\x1b[0m\r\n",
        "\x1b[1;36m⏺ \x1b[0mNow let me check the related component.\r\n",
        "\x1b[2m  Tool: Read src/hooks/useSession.ts\x1b[0m\r\n",
        "\x1b[2m  Tool: Edit src/components/SessionList.tsx\x1b[0m\r\n",
        "\x1b[33m  ⎿ Updated 3 files\x1b[0m\r\n",
        "\x1b[2m  Cost: $0.0523 | Tokens: 12.4k in, 3.2k out\x1b[0m\r\n",
        "\x1b[1;32m✓\x1b[0m Changes applied successfully.\r\n",
        "$ \x1b[0m",
    ];
    let mut buf = Vec::new();
    // Repeat to fill ~4KB
    for _ in 0..8 {
        for line in &lines {
            buf.extend_from_slice(line.as_bytes());
        }
    }
    buf.truncate(4096);
    buf
}

/// Plain text output (e.g. cargo build, test runner).
fn plain_text_chunk() -> Vec<u8> {
    let mut buf = Vec::with_capacity(4096);
    for i in 0..80 {
        let line = format!("    Compiling some-crate v0.{}.0 (/path/to/crate)\n", i);
        buf.extend_from_slice(line.as_bytes());
    }
    buf.truncate(4096);
    buf
}

// ─── Benchmarks ──────────────────────────────────────────────────────

fn bench_process(c: &mut Criterion) {
    let ansi_chunk = ansi_heavy_chunk();
    let agent_chunk = agent_output_chunk();
    let plain_chunk = plain_text_chunk();

    let mut group = c.benchmark_group("analyzer_process");

    group.bench_function("ansi_heavy_4kb", |b| {
        let mut analyzer = OutputAnalyzer::new();
        b.iter(|| {
            analyzer.process(black_box(&ansi_chunk));
        });
    });

    group.bench_function("agent_output_4kb", |b| {
        let mut analyzer = OutputAnalyzer::new();
        b.iter(|| {
            analyzer.process(black_box(&agent_chunk));
        });
    });

    group.bench_function("plain_text_4kb", |b| {
        let mut analyzer = OutputAnalyzer::new();
        b.iter(|| {
            analyzer.process(black_box(&plain_chunk));
        });
    });

    group.finish();
}

fn bench_to_metrics(c: &mut Criterion) {
    let mut group = c.benchmark_group("analyzer_to_metrics");

    // Cold — freshly created analyzer with no data
    group.bench_function("empty", |b| {
        let analyzer = OutputAnalyzer::new();
        b.iter(|| {
            black_box(analyzer.to_metrics());
        });
    });

    // Warm — analyzer that has processed substantial output
    group.bench_function("after_1000_chunks", |b| {
        let mut analyzer = OutputAnalyzer::new();
        let chunk = agent_output_chunk();
        for _ in 0..1000 {
            analyzer.process(&chunk);
        }
        b.iter(|| {
            black_box(analyzer.to_metrics());
        });
    });

    group.finish();
}

fn bench_process_throughput(c: &mut Criterion) {
    let mut group = c.benchmark_group("analyzer_throughput");

    // Measure how fast we can push data through the analyzer
    // (simulates sustained agent output)
    for chunk_count in [100, 500, 1000] {
        let chunk = agent_output_chunk();
        group.bench_with_input(
            BenchmarkId::new("agent_chunks", chunk_count),
            &chunk_count,
            |b, &count| {
                b.iter(|| {
                    let mut analyzer = OutputAnalyzer::new();
                    for _ in 0..count {
                        analyzer.process(black_box(&chunk));
                    }
                    black_box(analyzer.to_metrics())
                });
            },
        );
    }

    group.finish();
}

fn bench_eviction(c: &mut Criterion) {
    let mut group = c.benchmark_group("analyzer_eviction");

    // Benchmark process() when files_touched and memory_facts are at capacity
    // (exercises the VecDeque eviction path)
    group.bench_function("at_capacity", |b| {
        let mut analyzer = OutputAnalyzer::new();
        // Fill up the analyzer to capacity by processing lots of output
        // with unique file paths
        for i in 0..200 {
            let chunk = format!(
                "\x1b[2m  Tool: Edit src/components/Component{}.tsx\x1b[0m\r\n\
                 \x1b[2m  Memory: fact_{} = value_{}\x1b[0m\r\n",
                i, i, i
            );
            analyzer.process(chunk.as_bytes());
        }
        // Now benchmark continued processing at capacity
        let chunk = agent_output_chunk();
        b.iter(|| {
            analyzer.process(black_box(&chunk));
        });
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_process,
    bench_to_metrics,
    bench_process_throughput,
    bench_eviction,
);
criterion_main!(benches);
