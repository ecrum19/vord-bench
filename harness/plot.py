#!/usr/bin/env python3
"""
Plot the results of a benchmark.
Usage: python3 harness/plot.py results/<name>
Writes PNG and PDF figures to results/<name>/figures/. Requires matplotlib.
"""
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402

SURFACE = '#fcfcfb'
TEXT = '#0b0b0b'
TEXT_SECONDARY = '#52514e'
GRID = '#e6e5e1'
# Categorical slots in fixed order (validated for adjacent pairs, light mode).
SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
# Outcomes use the status palette, always together with a glyph and a legend label.
OUTCOMES = {
    'complete': ('#0ca30c', '✓', 'complete'),
    'incomplete': ('#ec835a', '≠', 'finished with wrong or missing results'),
    'timeout': ('#fab219', 'T', 'timed out'),
    'error': ('#d03b3b', '✗', 'error or crash'),
}
SCENARIO_LABELS = {'federated': 'Federated (4 endpoints)', 'single': 'Single endpoint'}

plt.rcParams.update({
    'font.size': 9,
    'axes.edgecolor': TEXT_SECONDARY,
    'axes.labelcolor': TEXT,
    'axes.facecolor': SURFACE,
    'figure.facecolor': SURFACE,
    'savefig.facecolor': SURFACE,
    'xtick.color': TEXT_SECONDARY,
    'ytick.color': TEXT_SECONDARY,
    'text.color': TEXT,
    'axes.spines.top': False,
    'axes.spines.right': False,
    'legend.frameon': False,
})


def is_complete(run):
    return run['status'] == 'ok' and run.get('recall') == 1 and run.get('precision') == 1


def outcome(run):
    if is_complete(run):
        return 'complete'
    if run['status'] == 'ok':
        return 'incomplete'
    if run['status'] in ('timeout', 'killed'):
        return 'timeout'
    return 'error'


def status_count(run, status):
    return (run.get('requests') or {}).get('byStatus', {}).get(status, 0)


def profile_label(profile):
    number, _, name = profile.partition('-')
    return f'{number}\n{name}'


class Results:
    def __init__(self, directory):
        self.directory = Path(directory)
        runs = [json.loads(line) for line in (self.directory / 'runs.jsonl').read_text().splitlines() if line]
        # The figures compare engines with advertised restrictions; other description modes are left out.
        self.runs = [run for run in runs if run.get('description', 'advertised') == 'advertised']
        selection = json.loads((self.directory / 'setup.json').read_text())['selection']
        present = {(run['profile'], run['scenario'], run['engine'], run['query']) for run in self.runs}
        self.profiles = [p for p in selection['profiles'] if any(key[0] == p for key in present)]
        self.engines = [e for e in selection['engines'] if any(key[2] == e for key in present)]
        self.queries = [q for q in selection['queries'] if any(key[3] == q for key in present)]
        self.groups = defaultdict(list)
        for run in self.runs:
            self.groups[(run['profile'], run['scenario'], run['engine'])].append(run)
            self.groups[(run['profile'], run['scenario'], run['engine'], run['query'])].append(run)

    def profiles_of(self, scenario):
        return [p for p in self.profiles if self.groups.get((p, scenario, self.engines[0]))]

    def common_queries(self, profile, scenario):
        """The queries that every engine completed in every replication."""
        return [q for q in self.queries if all(
            self.groups.get((profile, scenario, engine, q)) and
            all(is_complete(run) for run in self.groups[(profile, scenario, engine, q)])
            for engine in self.engines)]


def color(engine_index):
    return SERIES[engine_index % len(SERIES)]


def grouped_bars(ax, results, profiles, value, ylabel):
    """Bars per profile, one per engine, separated by a surface gap."""
    count = len(results.engines)
    width = 0.8 / count
    for index, engine in enumerate(results.engines):
        xs = [p + (index - (count - 1) / 2) * width for p in range(len(profiles))]
        ys = [value(profile, engine) for profile in profiles]
        ax.bar(xs, ys, width, color=color(index), edgecolor=SURFACE, linewidth=1.5, label=engine, zorder=2)
    ax.set_xticks(range(len(profiles)), [profile_label(p) for p in profiles])
    ax.set_ylabel(ylabel)
    ax.grid(axis='y', color=GRID, linewidth=0.8, zorder=0)
    ax.tick_params(axis='x', length=0)


def engine_legend(fig, results):
    handles = [Patch(color=color(i), label=engine) for i, engine in enumerate(results.engines)]
    fig.legend(handles=handles, loc='upper center', ncol=len(handles), bbox_to_anchor=(0.5, 1.0),
               handlelength=1.2, columnspacing=1.4)


def save(fig, out_dir, name):
    for extension in ('png', 'pdf'):
        fig.savefig(out_dir / f'{name}.{extension}', dpi=200, bbox_inches='tight')
    plt.close(fig)
    print(f'{out_dir / name}.png')


def plot_completeness(results, out_dir):
    scenarios = [s for s in ('federated', 'single') if results.profiles_of(s)]
    fig, axes = plt.subplots(len(scenarios), 1, figsize=(8, 2.6 * len(scenarios)), squeeze=False)
    for ax, scenario in zip(axes[:, 0], scenarios):
        profiles = results.profiles_of(scenario)

        def value(profile, engine, scenario=scenario):
            runs = results.groups[(profile, scenario, engine)]
            return 100 * sum(is_complete(run) for run in runs) / len(runs)

        grouped_bars(ax, results, profiles, value, 'complete runs (%)')
        ax.set_ylim(0, 100)
        ax.set_title(SCENARIO_LABELS[scenario], loc='left', fontsize=10, color=TEXT)
    engine_legend(fig, results)
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    save(fig, out_dir, 'completeness')


def plot_federated_metric(results, out_dir, name, title, ylabel, run_value, log=False):
    profiles = results.profiles_of('federated')
    fig, ax = plt.subplots(figsize=(8, 3))

    def value(profile, engine):
        return statistics.mean(run_value(run) for run in results.groups[(profile, 'federated', engine)])

    grouped_bars(ax, results, profiles, value, ylabel)
    if log:
        ax.set_yscale('symlog', linthresh=1)
        ax.set_ylim(bottom=0)
    ax.set_title(title, loc='left', fontsize=10, color=TEXT)
    engine_legend(fig, results)
    fig.tight_layout(rect=(0, 0, 1, 0.9))
    save(fig, out_dir, name)


def plot_time(results, out_dir):
    profiles = results.profiles_of('federated')
    common = {profile: results.common_queries(profile, 'federated') for profile in profiles}
    fig, ax = plt.subplots(figsize=(8, 3))

    def value(profile, engine):
        return sum(statistics.median(run['timeMs'] for run in results.groups[(profile, 'federated', engine, q)]) / 1000
                   for q in common[profile])

    grouped_bars(ax, results, profiles, value, 'total time (s)')
    ax.set_xticks(range(len(profiles)), [f'{profile_label(p)}\nn={len(common[p])}' for p in profiles])
    ax.set_title('Time for the queries that every engine completed (sum of medians, federated)',
                 loc='left', fontsize=10, color=TEXT)
    engine_legend(fig, results)
    fig.tight_layout(rect=(0, 0, 1, 0.9))
    save(fig, out_dir, 'time')


def plot_outcomes(results, out_dir, scenario='federated'):
    """A matrix of the outcome of every query and engine, per profile."""
    profiles = results.profiles_of(scenario)
    queries = [q for q in results.queries if any(results.groups.get((p, scenario, results.engines[0], q)) for p in profiles)]
    engines = results.engines
    cell = 0.22
    fig, axes = plt.subplots(1, len(profiles), figsize=(len(profiles) * len(engines) * cell + 1.6,
                                                        len(queries) * cell + 1.6), sharey=True)
    for ax, profile in zip(axes, profiles):
        for row, query in enumerate(queries):
            for column, engine in enumerate(engines):
                runs = results.groups.get((profile, scenario, engine, query), [])
                if not runs:
                    continue
                outcomes = [outcome(run) for run in runs]
                # The most frequent outcome, preferring the worse one in a tie.
                worst_first = list(reversed(list(OUTCOMES)))
                kind = max(worst_first, key=outcomes.count)
                fill, glyph, _ = OUTCOMES[kind]
                ax.add_patch(plt.Rectangle((column, row), 1, 1, facecolor=fill, edgecolor=SURFACE, linewidth=1.5))
                ax.text(column + 0.5, row + 0.52, glyph, ha='center', va='center', fontsize=6.5, color=TEXT)
        ax.set_xlim(0, len(engines))
        ax.set_ylim(len(queries), 0)
        ax.set_xticks([i + 0.5 for i in range(len(engines))], [e.split('-')[0] for e in engines], fontsize=7)
        ax.set_yticks([i + 0.5 for i in range(len(queries))], queries, fontsize=7)
        ax.tick_params(length=0)
        for spine in ax.spines.values():
            spine.set_visible(False)
        ax.set_title(profile_label(profile), fontsize=8, color=TEXT)
    handles = [Patch(facecolor=fill, label=f'{glyph}  {label}') for fill, glyph, label in OUTCOMES.values()]
    height = fig.get_figheight()
    fig.legend(handles=handles, loc='lower center', ncol=len(handles), bbox_to_anchor=(0.5, 0), handlelength=1.2)
    fig.suptitle(f'Outcome per query and engine: {SCENARIO_LABELS[scenario].lower()}, most frequent of the replications',
                 y=1 - 0.1 / height, va='top', fontsize=10)
    fig.tight_layout(rect=(0, 0.35 / height, 1, 1 - 0.35 / height))
    save(fig, out_dir, f'outcomes-{scenario}')


def main(directory):
    results = Results(directory)
    out_dir = results.directory / 'figures'
    out_dir.mkdir(exist_ok=True)
    plot_completeness(results, out_dir)
    plot_federated_metric(results, out_dir, 'rejections',
                          'Rejected requests per run (429 and 503 responses, federated)', 'requests per run (mean)',
                          lambda run: status_count(run, '429') + status_count(run, '503'), log=True)
    plot_federated_metric(results, out_dir, 'requests', 'Requests per run (federated)', 'requests per run (mean)',
                          lambda run: (run.get('requests') or {}).get('queries', 0), log=True)
    plot_time(results, out_dir)
    plot_outcomes(results, out_dir, 'federated')
    if results.profiles_of('single'):
        plot_outcomes(results, out_dir, 'single')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
