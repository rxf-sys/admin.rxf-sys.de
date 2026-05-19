from __future__ import annotations

import httpx
import pytest
import respx

from app.clients import proxmox


@pytest.mark.asyncio
@respx.mock
async def test_fetch_host_status_ok(settings):
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    respx.get(f"{base}/nodes/{settings.proxmox_node}/status").respond(
        200,
        json={
            "data": {
                "cpu": 0.25,
                "uptime": 3600,
                "kversion": "Linux 6.17",
                "memory": {"used": 1_000_000, "total": 4_000_000},
                "rootfs": {"used": 10_000_000, "total": 100_000_000},
                "cpuinfo": {"cpus": 8},
            }
        },
    )
    respx.get(f"{base}/version").respond(200, json={"data": {"version": "9.1.9"}})
    respx.get(f"{base}/nodes/{settings.proxmox_node}/disks/list").respond(
        200,
        json={
            "data": [
                {
                    "devpath": "/dev/sda",
                    "model": "Samsung SSD",
                    "size": 1_000_000_000,
                    "health": "PASSED",
                    "type": "ssd",
                    "temperature": 38,
                }
            ]
        },
    )

    host = await proxmox.fetch_host_status(settings)

    assert host.online is True
    assert host.node == "test-node"
    assert host.pve_version == "9.1.9"
    assert host.cpu_cores == 8
    assert host.cpu_pct == pytest.approx(25.0)
    assert host.ram_total_b == 4_000_000
    assert len(host.disks) == 1
    assert host.disks[0].health == "PASSED"
    assert host.disks[0].temp_c == 38.0


@pytest.mark.asyncio
@respx.mock
async def test_fetch_host_status_offline_on_network_error(settings):
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    respx.get(f"{base}/nodes/{settings.proxmox_node}/status").mock(
        side_effect=httpx.ConnectError("refused")
    )

    host = await proxmox.fetch_host_status(settings)

    assert host.online is False
    assert host.node == "test-node"


@pytest.mark.asyncio
@respx.mock
async def test_fetch_guests_returns_empty_on_error(settings):
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    respx.get(f"{base}/nodes/{settings.proxmox_node}/lxc").mock(
        side_effect=httpx.ConnectError("nope")
    )

    guests = await proxmox.fetch_guests(settings)

    assert guests == []


@pytest.mark.asyncio
@respx.mock
async def test_fetch_guests_maps_lxc_and_qemu(settings):
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    respx.get(f"{base}/nodes/{settings.proxmox_node}/lxc").respond(
        200,
        json={
            "data": [
                {
                    "vmid": 100,
                    "name": "nas",
                    "status": "running",
                    "cpu": 0.05,
                    "mem": 500,
                    "maxmem": 1000,
                    "uptime": 100,
                }
            ]
        },
    )
    respx.get(f"{base}/nodes/{settings.proxmox_node}/qemu").respond(
        200,
        json={
            "data": [
                {
                    "vmid": 200,
                    "name": "homeassistant",
                    "status": "stopped",
                    "cpu": 0.0,
                    "mem": 0,
                    "maxmem": 2048,
                    "uptime": 0,
                }
            ]
        },
    )
    # Config endpoint for the running LXC; minimal stub
    respx.get(f"{base}/nodes/{settings.proxmox_node}/lxc/100/config").respond(
        200, json={"data": {"net0": "name=eth0,bridge=vmbr0,ip=192.168.2.201/24"}}
    )

    guests = await proxmox.fetch_guests(settings)

    assert len(guests) == 2
    by_id = {g.id: g for g in guests}
    assert by_id[100].running is True
    assert by_id[100].type == "LXC"
    assert by_id[100].ip == "192.168.2.201"
    assert by_id[100].service == "Samba (NAS)"
    assert by_id[200].running is False
    assert by_id[200].type == "VM"
    assert by_id[200].status == "idle"


@pytest.mark.asyncio
@respx.mock
async def test_fetch_guest_tasks(settings):
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    respx.get(f"{base}/nodes/{settings.proxmox_node}/tasks?vmid=101&limit=5").respond(
        200,
        json={
            "data": [
                {
                    "upid": "UPID:test:1",
                    "type": "vzreboot",
                    "user": "root@pam",
                    "status": "OK",
                    "starttime": 1700000000,
                    "endtime": 1700000010,
                },
                {
                    "upid": "UPID:test:2",
                    "type": "vzstart",
                    "user": "root@pam",
                    "status": "OK",
                    "starttime": 1700000050,
                    "endtime": 0,
                },
            ]
        },
    )

    tasks = await proxmox.fetch_guest_tasks(settings, 101, limit=5)

    assert len(tasks) == 2
    assert tasks[0]["upid"] == "UPID:test:1"
    assert tasks[0]["status"] == "OK"
    assert tasks[1]["endtime"] is None  # 0 is normalized


@pytest.mark.asyncio
@respx.mock
async def test_fetch_guest_tasks_returns_empty_on_error(settings):
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    respx.get(f"{base}/nodes/{settings.proxmox_node}/tasks?vmid=101&limit=10").mock(
        side_effect=httpx.ConnectError("nope")
    )

    tasks = await proxmox.fetch_guest_tasks(settings, 101)

    assert tasks == []


@pytest.mark.asyncio
@respx.mock
async def test_fetch_task_log(settings):
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    respx.get(
        f"{base}/nodes/{settings.proxmox_node}/tasks/UPID:abc/log?limit=50"
    ).respond(
        200,
        json={
            "data": [
                {"n": 2, "t": "second line"},
                {"n": 1, "t": "first line"},
            ]
        },
    )

    lines = await proxmox.fetch_task_log(settings, "UPID:abc", limit=50)

    assert [line["t"] for line in lines] == ["first line", "second line"]


@pytest.mark.asyncio
@respx.mock
async def test_fetch_host_journal_filters_by_vmid(settings):
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    respx.get(f"{base}/nodes/{settings.proxmox_node}/journal?lastentries=500").respond(
        200,
        json={
            "data": [
                "Jan 12 10:00 host kernel: lxc-100: started",
                "Jan 12 10:01 host systemd: pve-container@200.service: stop",
                "Jan 12 10:02 host pveproxy: CT 100 backup ok",
                # Unrelated entries — must not appear.
                "Jan 12 10:03 host kernel: random pid 10000 noise",
                "Jan 12 10:04 host audit: msg=audit(1707730000.123:456) bogus",
            ]
        },
    )

    lines = await proxmox.fetch_host_journal_for_vmid(settings, 100)

    # Only the three lines that mention 100 as a recognisable token.
    assert len(lines) == 2
    assert any("lxc-100" in line for line in lines)
    assert any("CT 100" in line for line in lines)
    # 10000 must NOT match because the regex uses word boundaries / shape.
    assert not any("pid 10000" in line for line in lines)


@pytest.mark.asyncio
@respx.mock
async def test_fetch_host_journal_returns_empty_on_error(settings):
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    respx.get(f"{base}/nodes/{settings.proxmox_node}/journal?lastentries=500").mock(
        side_effect=httpx.ConnectError("denied")
    )

    lines = await proxmox.fetch_host_journal_for_vmid(settings, 100)

    assert lines == []


@pytest.mark.asyncio
@respx.mock
async def test_restart_guest_lxc_polls_upid_until_ok(settings):
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    upid = "UPID:test-node:0000ABCD:0:reboot::root@pam:"
    reboot_route = respx.post(
        f"{base}/nodes/{settings.proxmox_node}/lxc/101/status/reboot"
    ).respond(200, json={"data": upid})
    status_route = respx.get(
        f"{base}/nodes/{settings.proxmox_node}/tasks/{upid}/status"
    ).respond(200, json={"data": {"status": "stopped", "exitstatus": "OK"}})

    ok = await proxmox.restart_guest(settings, 101, "lxc")

    assert ok is True
    assert reboot_route.called
    assert status_route.called


@pytest.mark.asyncio
@respx.mock
async def test_restart_guest_lxc_reports_task_failure(settings):
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    upid = "UPID:test-node:0000DEAD:0:reboot::root@pam:"
    respx.post(f"{base}/nodes/{settings.proxmox_node}/lxc/101/status/reboot").respond(
        200, json={"data": upid}
    )
    respx.get(f"{base}/nodes/{settings.proxmox_node}/tasks/{upid}/status").respond(
        200, json={"data": {"status": "stopped", "exitstatus": "command failed"}}
    )

    ok = await proxmox.restart_guest(settings, 101, "lxc")

    assert ok is False


@pytest.mark.asyncio
@respx.mock
async def test_restart_guest_lxc_without_upid_falls_back_to_http_status(settings):
    """Old/proxy responses that don't echo a UPID still count as success."""
    base = f"https://{settings.proxmox_host}:{settings.proxmox_port}/api2/json"
    respx.post(f"{base}/nodes/{settings.proxmox_node}/lxc/101/status/reboot").respond(
        200, json={"data": None}
    )

    ok = await proxmox.restart_guest(settings, 101, "lxc")

    assert ok is True
